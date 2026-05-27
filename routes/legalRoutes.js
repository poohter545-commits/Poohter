const express = require('express');
const { requestAccountDeletion } = require('../controllers/legalController');

const router = express.Router();

router.post('/account-deletion-requests', requestAccountDeletion);

module.exports = router;
