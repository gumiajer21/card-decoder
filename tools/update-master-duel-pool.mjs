import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const sources = {
  cardList: 'https://raw.githubusercontent.com/pixeltris/YgoMaster/master/YgoMaster/Data/CardList.json',
  ydkIds: 'https://raw.githubusercontent.com/pixeltris/YgoMaster/master/YgoMaster/Data/YdkIds.txt',
};
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'card-decoder-pool-'));
try {
  const [cardListResponse, ydkResponse] = await Promise.all([fetch(sources.cardList), fetch(sources.ydkIds)]);
  if (!cardListResponse.ok || !ydkResponse.ok) throw new Error(`下载失败：CardList ${cardListResponse.status}，YdkIds ${ydkResponse.status}`);
  const cardListPath = path.join(temp, 'CardList.json');
  const ydkPath = path.join(temp, 'YdkIds.txt');
  await Promise.all([
    fs.writeFile(cardListPath, await cardListResponse.text()),
    fs.writeFile(ydkPath, await ydkResponse.text()),
  ]);
  const refine = spawnSync(process.execPath, [path.join(import.meta.dirname, 'refine-master-duel-pool.mjs'), cardListPath, ydkPath], { stdio: 'inherit' });
  if (refine.status !== 0) process.exit(refine.status || 1);
  console.log('大师决斗游戏内校准卡池已更新。请重新打开网页。');
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
