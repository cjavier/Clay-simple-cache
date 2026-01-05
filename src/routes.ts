import { Router } from 'express';
import { profilesController } from './controllers/profiles.controller';

const router = Router();

router.post('/profiles', profilesController.upsert);
router.get('/profiles', profilesController.get);

export default router;
