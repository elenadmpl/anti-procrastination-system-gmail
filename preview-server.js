const http=require('http'),fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'extension','workspace');
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png','.wasm':'application/wasm','.gz':'application/gzip'};
const port=Number(process.env.ORBIT_PORT||4387);
http.createServer((req,res)=>{
 if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end();return;}
 let url;try{url=new URL(req.url,'http://127.0.0.1');}catch{res.writeHead(400);res.end();return;}
 let name;try{name=decodeURIComponent(url.pathname);}catch{res.writeHead(400);res.end();return;}
 const file=path.resolve(root,'.'+(name==='/'?'/index.html':name));
 if(file!==root&&!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
 fs.stat(file,(err,stat)=>{if(err||!stat.isFile()){res.writeHead(404);res.end('Not found');return;}
 res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':name.endsWith('private-review.json')?'no-store':'no-cache','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'"});
 if(req.method==='HEAD'){res.end();return;}fs.createReadStream(file).pipe(res);
 });
}).listen(port,'127.0.0.1',()=>console.log('Orbit is ready at http://127.0.0.1:'+port));
