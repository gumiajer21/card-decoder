import fs from 'node:fs';
import path from 'node:path';

const project = path.resolve(import.meta.dirname, '..');
const cardDataPath = path.join(project, 'dist', 'cards-data.js');
const cardListPath = process.argv[2];
const ydkMapPath = process.argv[3];
if (!cardListPath || !ydkMapPath) {
  throw new Error('用法：node tools/refine-master-duel-pool.mjs <CardList.json> <YdkIds.txt>');
}

const raw = fs.readFileSync(cardDataPath, 'utf8').trim();
const payload = JSON.parse(raw.replace(/^window\.CARD_DATA=/, '').replace(/;$/, ''));
const internalIds = new Set(Object.keys(JSON.parse(fs.readFileSync(cardListPath, 'utf8'))).map(Number));
const passcodes = new Set();
for (const line of fs.readFileSync(ydkMapPath, 'utf8').split(/\r?\n/)) {
  const [passcode, internalId] = line.trim().split(/\s+/).map(Number);
  if (passcode > 0 && internalIds.has(internalId)) passcodes.add(passcode);
}

let records = 0;
for (const group of payload.cards) {
  group.wm = group.ids.reduce((sum, id) => sum + (passcodes.has(Number(id)) ? 1 : 0), 0);
  records += group.wm;
}
payload.generatedAt = new Date().toISOString();
payload.stats.masterDuelMonsterRecords = records;
payload.stats.masterDuelGroups = payload.cards.filter((card) => card.wm > 0).length;
payload.source = {
  masterDuelPool: 'YgoMaster CardList.json + YdkIds.txt',
  note: '游戏内可用卡清单的社区提取；活动仍可能额外排除少量卡片。',
};
fs.writeFileSync(cardDataPath, `window.CARD_DATA=${JSON.stringify(payload)};\n`, 'utf8');
console.log(JSON.stringify({ internalIds: internalIds.size, mappedPasscodes: passcodes.size, monsterRecords: records, behaviorGroups: payload.stats.masterDuelGroups }, null, 2));
