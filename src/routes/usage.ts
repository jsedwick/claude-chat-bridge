import { Router } from 'express';
import { getSummary } from '../services/usage-ledger';

const router = Router();

// Month-to-date metered spend, aggregated from the per-turn ledger.
router.get('/summary', (_req, res) => {
  res.json(getSummary());
});

export default router;
