#!/usr/bin/env bash
# Data copy Supabase (public.*) → sistema-outbound Postgres (clay_cache.*).
#
# The target schema is created by sistema-outbound's migration 0220; this only
# moves rows, and only ever writes inside clay_cache.
#
#   SRC_URL=postgres://…supabase…  DST_URL=postgres://…railway…  copy-data.sh full
#   SRC_URL=… DST_URL=… copy-data.sh delta 2026-10-24T00:00:00Z   # upsert rows touched since
#   DELETE_GONE=1 … delta <since>   # also delete target keys gone at the source (freeze only)
#   SRC_URL=… DST_URL=… copy-data.sh verify                         # count + md5 per table
#   ONLY=profiles,search_log … full|delta|verify   # a subset, still in FK order
#   VERIFY_FAST=1 … verify <since>   # freeze: table_job_batches.rows hashed only where updated since
#   SRC_URL=… DST_URL=… copy-data.sh refresh <table>                # re-copy one table whole
#
# full refuses to run on a non-empty target table. delta upserts by primary key
# the rows whose newest timestamp column is >= since, then deletes target rows
# whose key no longer exists at the source. verify compares, per table, the
# row count and an md5 over every row (columns in source order, ordered by pk),
# so any row missed or changed outside a timestamp shows up.
set -euo pipefail

: "${SRC_URL:?SRC_URL is required}"
: "${DST_URL:?DST_URL is required}"
SCHEMA="${DST_SCHEMA:-clay_cache}"
SRC_SCHEMA="${SRC_SCHEMA:-public}"  # clay_cache when the source is a copy already loaded
# Supabase's postgres role has a statement_timeout that cuts a big COPY short;
# its pooler ignores PGOPTIONS, so src() also sets it in the session.
export PGTZ=UTC PGOPTIONS="-c TimeZone=UTC -c statement_timeout=0"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
# Page cache of copy_table (holds row data: keep it private, it is removed per table on success).
CACHE_DIR="${CACHE_DIR:-${TMPDIR:-/tmp}/clay-copy-cache}"

# table|primary key|change signal|delta mode. Parents before children.
#   signal: timestamp columns every write path sets (newest of them = last touched)
#   mode:   delta   = upsert rows whose signal >= since
#           refresh = no reliable signal (or tiny): re-copied whole in the freeze
# Nothing in the code deletes rows; delta still removes keys gone at the source.
TABLES=(
  "clients|id|created_at,updated_at|refresh"          # 0 rows
  "companies|id|created_at,updated_at|refresh"        # 205 rows
  "dnc_entries|id|created_at|refresh"                 # 0 rows
  "profiles|id|created_at,updated_at|delta"           # Prisma update → @updatedAt
  "verification_cache|id|verified_at|delta"           # upsert sets verified_at
  "domain_patterns|id|last_confirmed|delta"           # raw upsert sets last_confirmed
  "domain_intel|id|checked_at|refresh"                # markDomainCatchAll flips is_catch_all without a timestamp
  "domain_health|domain|updated_at,last_hit_at|delta" # raw upsert sets updated_at in both branches
  "search_log|id|created_at|delta"                    # insert-only
  "finder_metrics|id|created_at|refresh"              # upsert, no update timestamp; ~100 rows
  "provider_credits|id|checked_at|delta"              # insert-only
  "serp_cache|id|checked_at|delta"                    # upsert sets checked_at
  "find_jobs|id|created_at,updated_at|refresh"        # 1 row
  "table_jobs|id|created_at,updated_at|refresh"       # 27 rows
  "table_job_batches|id|created_at,updated_at|delta"  # Prisma update/updateMany → @updatedAt
  "email_outcomes|source,source_ref|updated_at|delta" # raw upsert sets updated_at = now()
  "email_provenance|id|created_at,pushed_at,checked_at|delta+unpushed" # push_error alone is written on rows with pushed_at null
  "email_attempts|id|created_at,updated_at|refresh"   # 128 rows, no writer left
  "email_provider_state|provider|updated_at|refresh"  # 5 rows
)

# ONLY=t1,t2 limits full/delta/verify to those tables (still in FK order).
if [[ -n ${ONLY:-} ]]; then
  _keep=()
  for spec in "${TABLES[@]}"; do [[ ",$ONLY," == *",${spec%%|*},"* ]] && _keep+=("$spec"); done
  [[ ${#_keep[@]} -gt 0 ]] || { echo "ONLY=$ONLY matches no table"; exit 2; }
  TABLES=("${_keep[@]}")
fi

src() { psql "$SRC_URL" -X -v ON_ERROR_STOP=1 -At -c "set statement_timeout = 0" -c "set timezone = 'UTC'" "$@" | sed "/^SET$/d"; }
dst() { psql "$DST_URL" -X -v ON_ERROR_STOP=1 -At "$@"; }  # no pooler: PGOPTIONS applies; stdin stays free for delta

cols() { # column list of public.$1 at the source, in source order
  src -c "select string_agg(quote_ident(column_name), ',' order by ordinal_position)
          from information_schema.columns where table_schema='$SRC_SCHEMA' and table_name='$1'"
}

check_target_columns() { # every source column must exist at the target
  local t=$1 c
  c=$(src -c "select string_agg(column_name, ',' order by column_name) from information_schema.columns where table_schema='$SRC_SCHEMA' and table_name='$t'")
  local d
  d=$(dst -c "select string_agg(column_name, ',' order by column_name) from information_schema.columns where table_schema='$SCHEMA' and table_name='$t'")
  if [[ "$c" != "$d" ]]; then
    echo "✗ $t: columns differ"; echo "   src: $c"; echo "   dst: $d"; return 1
  fi
}

copy_table() { # $1 table
  # Through files, never a pipe: a source read that dies halfway would still
  # end the target's COPY cleanly and commit the rows it got. Tables with an
  # `id` are read in pages of PAGE rows by id range, each page retried: the
  # Supabase pooler drops any session that streams for minutes, and the Free
  # instance serves table_job_batches' jsonb at ~200 KB/s. The load is one
  # target transaction, so a table lands whole or not at all.
  #
  # Pages and their plan live in $CACHE_DIR until the load commits: a rejected
  # load (say, an FK) reruns from disk instead of paying the source read again.
  # A page is only kept once complete (written to .part, then renamed). Rows
  # the source gains after the plan was made are the delta's job.
  local t=$1 c parts=() i prev="" b dir
  local page=${PAGE:-20000}
  [[ $t == table_job_batches ]] && page=${PAGE_BATCHES:-150}
  dir="$CACHE_DIR/$(printf '%s|%s' "$SRC_URL" "$SRC_SCHEMA" | shasum | cut -c1-10)/$t"
  mkdir -p "$dir"; chmod 700 "$CACHE_DIR"
  c=$(cols "$t")
  if [[ -s "$dir/plan" ]]; then
    while IFS= read -r b; do parts+=("$b"); done < "$dir/plan"
    echo "  $t: resuming a saved plan of ${#parts[@]} pages ($(ls "$dir" | grep -c '\.copy$') already on disk)" >&2
  else
    if [[ -n "$(src -c "select 1 from information_schema.columns where table_schema='$SRC_SCHEMA' and table_name='$t' and column_name='id'")" ]]; then
      # Page boundaries from the ids alone (index-only, cheap).
      while read -r b; do
        parts+=("${prev:+id > '$prev' and }id <= '$b'"); prev=$b
      done < <(src -c "select id from (select id, row_number() over (order by id) rn from $SRC_SCHEMA.$t) s where rn % $page = 0 order by id")
      parts+=("${prev:+id > '$prev'}"); [[ -z "$prev" ]] && parts[${#parts[@]}-1]="true"
    else
      parts=("true")
    fi
    printf '%s\n' "${parts[@]}" > "$dir/plan"
  fi
  for i in "${!parts[@]}"; do
    [[ -f "$dir/$i.copy" ]] && continue
    local ok=0 try
    for try in 1 2 3 4 5; do
      if src -c "\\copy (select $c from $SRC_SCHEMA.$t where ${parts[$i]}) to '$dir/$i.part'"; then
        mv "$dir/$i.part" "$dir/$i.copy"; ok=1; break
      fi
      echo "  $t page $i: retry $try" >&2; sleep $((try * 5))
    done
    [[ $ok == 1 ]] || { echo "✗ $t: page $i failed 5 times, nothing loaded (pages kept in $dir)"; return 1; }
  done
  {
    echo "begin;"
    for i in "${!parts[@]}"; do echo "\\copy $SCHEMA.$t ($c) from '$dir/$i.copy'"; done
    echo "commit;"
  } | dst -q || { echo "✗ $t: load rejected, nothing committed (pages kept in $dir)"; return 1; }
  rm -rf "$dir"
}

cmd_full() {
  for spec in "${TABLES[@]}"; do
    IFS='|' read -r t _ _ _ <<<"$spec"
    check_target_columns "$t"
    local n
    n=$(dst -c "select count(*) from $SCHEMA.$t")
    if [[ "$n" != 0 ]]; then echo "✗ $SCHEMA.$t already has $n rows; use delta or refresh"; exit 1; fi
  done
  for spec in "${TABLES[@]}"; do
    IFS='|' read -r t _ _ _ <<<"$spec"
    local s=$SECONDS
    copy_table "$t"
    echo "✓ $t $(dst -c "select count(*) from $SCHEMA.$t") rows ($((SECONDS - s))s)"
  done
  echo "  (run ANALYZE on $SCHEMA as the table owner: the loader role cannot)"
}

cmd_delta() {
  local since=${1:?delta needs a since timestamp (ISO 8601)}
  for spec in "${TABLES[@]}"; do
    IFS='|' read -r t pk ts mode <<<"$spec"
    local c newest set
    c=$(cols "$t")
    newest="greatest($(sed -E 's/([a-z_]+)/coalesce(\1, '"'"'-infinity'"'"')/g' <<<"$ts")) >= '$since'"
    [[ $mode == delta+unpushed ]] && newest="($newest or pushed_at is null)"
    # No reliable signal: upsert every row (no truncate: FK parents, no empty window).
    [[ $mode == refresh ]] && newest="true"
    set=$(src -c "select string_agg(quote_ident(column_name)||'=excluded.'||quote_ident(column_name), ',')
                  from information_schema.columns where table_schema='$SRC_SCHEMA' and table_name='$t'
                  and column_name <> all(string_to_array('$pk', ','))")
    # Changed rows → file → temp table → upsert, in one target transaction.
    src -c "\\copy (select $c from $SRC_SCHEMA.$t where $newest) to '$TMP/$t.d'"
    [[ ${DELETE_GONE:-0} == 1 ]] && src -c "\\copy (select $pk from $SRC_SCHEMA.$t) to '$TMP/$t.k'"
    {
      echo "begin;"
      echo "create temp table _d (like $SCHEMA.$t including defaults) on commit drop;"
      echo "\\copy _d ($c) from '$TMP/$t.d'"
      echo "insert into $SCHEMA.$t ($c) select $c from _d on conflict ($pk) do update set $set;"
      echo "select 'upserted', count(*) from _d;"
      echo "commit;"
    } | dst -q | sed "s/^/  $t: /"
    # Keys gone at the source: only inside the freeze (old service stopped),
    # never while it still writes.
    [[ ${DELETE_GONE:-0} == 1 ]] || continue
    {
      echo "begin;"
      echo "create temp table _k as select $pk from $SCHEMA.$t limit 0;"
      echo "\\copy _k from '$TMP/$t.k'"
      echo "with gone as (delete from $SCHEMA.$t x where not exists (select 1 from _k k where ($(sed -E 's/([a-z_]+)/k.\1/g' <<<"$pk")) = ($(sed -E 's/([a-z_]+)/x.\1/g' <<<"$pk"))) returning 1) select 'deleted', count(*) from gone;"
      echo "commit;"
    } | dst -q | sed "s/^/  $t: /"
  done
}

cmd_refresh() {
  local t=${1:?refresh needs a table}
  check_target_columns "$t"
  dst -c "truncate $SCHEMA.$t"
  copy_table "$t"
  echo "✓ $t refreshed: $(dst -c "select count(*) from $SCHEMA.$t") rows"
}

cmd_verify() {
  # VERIFY_FAST=1 verify <since>: inside the freeze, table_job_batches' `rows`
  # (264 MB of TOAST Supabase serves at ~200 KB/s) is hashed only for rows
  # updated since <since>; every other column of every row is still hashed.
  # Sound because its only writer is Prisma, whose @updatedAt moves on every
  # update, and the full hash of the older rows was proven before the freeze.
  local bad=0 fast=${VERIFY_FAST:-0} since=${1:-}
  [[ $fast == 1 && -z $since ]] && { echo "VERIFY_FAST=1 needs: verify <since>"; return 2; }
  printf '%-30s %10s %10s  %s\n' table src dst result
  _check() { # label, columns, pk, table, where
    local q a b r
    q="select count(*)||' '||coalesce(md5(string_agg(md5(row($2)::text), '' order by $3)), '-') from"
    a=$(src -c "$q $SRC_SCHEMA.$4 where $5")
    b=$(dst -c "$q $SCHEMA.$4 where $5")
    if [[ "$a" == "$b" ]]; then r="ok"; else r="DIFF"; bad=1; fi
    printf '%-30s %10s %10s  %s\n' "$1" "${a%% *}" "${b%% *}" "$r"
  }
  for spec in "${TABLES[@]}"; do
    IFS='|' read -r t pk _ _ <<<"$spec"
    local c
    c=$(cols "$t")
    if [[ $fast == 1 && $t == table_job_batches ]]; then
      _check "$t (sin rows)" "$(sed -E 's/(^|,)rows(,|$)/\1\2/; s/,,/,/; s/^,|,$//g' <<<"$c")" "$pk" "$t" "true"
      _check "$t (rows, upd>=since)" "$c" "$pk" "$t" "updated_at >= '$since'"
    else
      _check "$t" "$c" "$pk" "$t" "true"
    fi
  done
  return $bad
}

case "${1:-}" in
  full) cmd_full ;;
  delta) cmd_delta "${2:-}" ;;
  refresh) cmd_refresh "${2:-}" ;;
  verify) cmd_verify "${2:-}" ;;
  *) sed -n '2,20p' "$0"; exit 2 ;;
esac
