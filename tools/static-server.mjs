import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve(process.argv[3]||'dist'),port=Number(process.argv[2]||8765),types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.png':'image/png','.svg':'image/svg+xml','.jpg':'image/jpeg','.webp':'image/webp'};
http.createServer((request,response)=>{const pathname=decodeURIComponent(new URL(request.url,'http://localhost').pathname),relative=pathname==='/'?'index.html':pathname.slice(1),file=path.resolve(root,relative);if(!file.startsWith(root)){response.writeHead(403).end();return}fs.readFile(file,(error,data)=>{if(error){response.writeHead(404).end('Not found');return}response.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});response.end(data);});}).listen(port,'127.0.0.1',()=>console.log(`http://127.0.0.1:${port}/`));
