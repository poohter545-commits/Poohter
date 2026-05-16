const pool = require('../config/db');
const { initProductionDb, ensureCoreTables } = require('../config/scripts/initProductionDb');

if (require.main === module) {
  initProductionDb()
    .catch((error) => {
      console.error(error.stack || error.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}

module.exports = {
  ensureCoreTables,
  initProductionDb,
};
