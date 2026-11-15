'use strict';

/**
 * Seed the local SQLite database from the fictional sample datasets in
 * data/samples/. Also creates the initial analysis version for each site.
 *
 *   node scripts/seed.js            # import only missing sites
 *   node scripts/seed.js --reset    # wipe and re-import everything
 */

const path = require('node:path');
const { Store, DEFAULT_DB_PATH } = require('../src/db');

const reset = process.argv.includes('--reset');
const dbPath = process.env.DB_PATH || DEFAULT_DB_PATH;

const store = new Store(dbPath);
try {
  const imported = store.seedFromSamples({ reset });
  if (!imported.length) {
    console.log(`没有需要导入的站点（${path.resolve(dbPath)} 已是最新）。`);
    console.log('如需从头重建，运行：npm run seed:reset');
  } else {
    const created = imported.filter((item) => !item.skipped);
    for (const item of imported) {
      if (item.skipped) {
        console.log(`已存在 ${item.siteId}（${item.siteName}），跳过。`);
        continue;
      }
      console.log(`已导入 ${item.siteId}：${item.statuses} 条状态 / ${item.orders} 条订单 / ${item.repairs} 条维修 / ${item.inbox} 条迟到消息 → 初始版本 v${item.version.seq}`);
    }
    if (!created.length) console.log('站点均已存在；如需从头重建，运行：npm run seed:reset');
    console.log(`数据库：${path.resolve(dbPath)}`);
  }
} catch (error) {
  console.error('导入失败：', error.message);
  process.exitCode = 1;
} finally {
  store.close();
}
