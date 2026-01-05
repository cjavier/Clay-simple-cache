import { Router } from 'express';
import { profilesController } from './controllers/profiles.controller';
import { companiesController } from './controllers/companies.controller';

const router = Router();

router.post('/profiles', profilesController.upsert);
router.get('/profiles', profilesController.get);

router.post('/companies', companiesController.upsert);
router.get('/companies', companiesController.get);

export default router;
