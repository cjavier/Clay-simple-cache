import { Router } from 'express';
import { profilesController } from './controllers/profiles.controller';
import { companiesController } from './controllers/companies.controller';

import { docsController } from './controllers/docs.controller';

const router = Router();

router.post('/profiles', profilesController.upsert);
router.get('/profiles', profilesController.get);

router.post('/companies', companiesController.upsert);
router.get('/companies', companiesController.get);

router.get('/docs/api', docsController.get);

export default router;
