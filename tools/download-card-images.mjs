import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(toolDir, '..');
const qualityArg = process.argv.find((arg) => arg.startsWith('--quality='))?.split('=')[1];
const quality = ['low', 'high', 'zh'].includes(qualityArg) ? qualityArg : 'low';
const qualityName = quality === 'zh' ? '简体中文' : quality === 'high' ? '高清' : '低清';
const remoteFolder = quality === 'high' ? 'cards' : 'cards_small';
const outputDir = path.join(projectDir, 'dist', quality === 'zh' ? 'card-images-zh' : quality === 'high' ? 'card-images-high' : 'card-images');
const extension = quality === 'zh' ? 'webp' : 'jpg';
globalThis.window = {};
await import(pathToFileURL(path.join(projectDir, 'dist', 'cards-data.js')).href);

let ids = [...new Set(window.CARD_DATA.cards
  .filter((card) => card.wm > 0)
  .flatMap((card) => card.ids || []))];
await fs.mkdir(outputDir, { recursive: true });
if (process.argv.includes('--dry-run')) {
  console.log(JSON.stringify({ images: ids.length, quality, remoteFolder: quality === 'zh' ? 'ygoimg/sc' : remoteFolder, extension, outputDir }));
  process.exit(0);
}

if (quality === 'zh') {
  console.log('正在读取中文卡图目录…');
  const metadataResponse = await fetch('https://cdn.233.momobako.com/ygoimg/sc/metadata');
  if (!metadataResponse.ok) throw new Error(`中文卡图目录读取失败：HTTP ${metadataResponse.status}`);
  const available = new Set((await metadataResponse.text()).match(/^\d+(?=\.webp:)/gm)?.map(Number) || []);
  ids = ids.filter((id) => available.has(id));
}

let completed = 0;
let downloaded = 0;
let skipped = 0;
let failed = 0;
let cursor = 0;
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function exists(file) {
  try { return (await fs.stat(file)).size > 0; } catch { return false; }
}

async function worker() {
  while (cursor < ids.length) {
    const id = ids[cursor++];
    const file = path.join(outputDir, `${id}.${extension}`);
    if (await exists(file)) {
      skipped += 1;
    } else {
      try {
        const url = quality === 'zh'
          ? `https://cdn.233.momobako.com/ygoimg/sc/${id}.webp`
          : `https://images.ygoprodeck.com/images/${remoteFolder}/${id}.jpg`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        await fs.writeFile(file, Buffer.from(await response.arrayBuffer()));
        downloaded += 1;
      } catch (error) {
        failed += 1;
        console.error(`\n${id} 下载失败：${error.message}`);
      }
      await delay(700);
    }
    completed += 1;
    if (completed % 25 === 0 || completed === ids.length) {
      process.stdout.write(`\r进度 ${completed}/${ids.length} · 新增 ${downloaded} · 已有 ${skipped} · 失败 ${failed}`);
    }
  }
}

console.log(`准备 ${ids.length} 张大师决斗近似卡池${qualityName}图。已存在的文件会自动跳过，可随时中断后继续。`);
await Promise.all([worker(), worker(), worker()]);
console.log(`\n完成。新增 ${downloaded}，已有 ${skipped}，失败 ${failed}。`);
