import { autoTestOutput, runAutoTest } from './helpers/autoTest.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { build } from 'vite';

await runAutoTest(async () => {
// Synthetic images only. Does not start Asterium or read its user data/keys.








const root = path.resolve(import.meta.dirname, '..');
const index = process.argv.indexOf('--output'), output = autoTestOutput(index < 0 ? undefined : process.argv[index + 1]);
if (process.platform !== 'win32' || !output || !path.isAbsolute(output)) throw Error('Use --output <fresh absolute evidence directory> on Windows');
const directory = path.resolve(output), relative = path.relative(root, directory);
if (directory === path.parse(directory).root || relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)) || fs.existsSync(directory)) throw Error('Evidence directory must be fresh and outside the repository');
fs.mkdirSync(directory, { recursive: true });
const bundle = await build({ configFile: false, logLevel: 'error', build: { write: false, minify: false, lib: { entry: path.join(root, 'src/main/security/attachmentThumbnail.ts'), formats: ['cjs'] }, rollupOptions: { external: ['electron', /^node:/] } } });
const code = (Array.isArray(bundle) ? bundle[0] : bundle).output.find(item => item.type === 'chunk' && item.isEntry).code;
fs.writeFileSync(path.join(directory, 'thumbnail.cjs'), code);
const driver = `
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {app,nativeImage,BrowserWindow}=require('electron');
const {createAttachmentThumbnail}=require('./thumbnail.cjs');
app.setPath('userData',path.join(__dirname,'electron-user-data'));app.disableHardwareAcceleration();
app.whenReady().then(async()=>{const report={status:'running',realModelCalled:false,memberAccountUsed:false,cases:[]};let window;
try{
 const source=nativeImage.createFromBitmap(Buffer.alloc(64*48*4,255),{width:64,height:48});
 for(const [format,bytes]of [['png',source.toPNG()],['jpeg',source.toJPEG(80)]]){
  const folder=path.join(__dirname,format);fs.mkdirSync(folder);
  for(const name of ['preview','content']){const file=path.join(folder,name);fs.writeFileSync(file,bytes);const value=await createAttachmentThumbnail(file);assert.ok(value.startsWith('data:image/png;base64,'));assert.deepEqual(nativeImage.createFromDataURL(value).getSize(),{width:64,height:48});assert.ok(bytes.equals(fs.readFileSync(file)));report.cases.push({case:format+'-'+name,passed:true});}
 }
 const named=path.join(__dirname,'named.png');fs.writeFileSync(named,source.toPNG());
 const shell={};for(const [label,file]of [['withExtension',named],['withoutExtension',path.join(__dirname,'png/content')]]){try{shell[label]={succeeded:!(await nativeImage.createThumbnailFromPath(file,{width:128,height:128})).isEmpty()};}catch(error){shell[label]={succeeded:false,error:error.message};}}report.previousShellApiProbe=shell;
 const large=nativeImage.createFromBitmap(Buffer.alloc(1920*1080*4,255),{width:1920,height:1080}),largeFile=path.join(__dirname,'large-content');fs.writeFileSync(largeFile,large.toPNG());assert.deepEqual(nativeImage.createFromDataURL(await createAttachmentThumbnail(largeFile)).getSize(),{width:960,height:540});report.cases.push({case:'aspect-ratio-bounds',passed:true});
 window=new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,contextIsolation:true}});await window.loadURL('data:text/html,<html></html>');
 const webp=await window.webContents.executeJavaScript("(()=>{const c=document.createElement('canvas');c.width=8;c.height=4;c.getContext('2d').fillRect(0,0,8,4);return c.toDataURL('image/webp');})()");assert.ok(webp.startsWith('data:image/webp;base64,'));
 const formats=[['webp',Buffer.from(webp.split(',')[1],'base64')],['gif',Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64')]];
 for(const [format,bytes]of formats){const file=path.join(__dirname,format+'-content');fs.writeFileSync(file,bytes);const result=await createAttachmentThumbnail(file);if(result)assert.ok(!nativeImage.createFromDataURL(result).isEmpty());assert.ok(bytes.equals(fs.readFileSync(file)));report.cases.push({case:format+'-thumbnail-or-safe-icon-fallback',passed:true,hasThumbnail:Boolean(result)});}
 const corrupt=path.join(__dirname,'corrupt');fs.writeFileSync(corrupt,'synthetic invalid image');assert.equal(await createAttachmentThumbnail(corrupt),'');report.cases.push({case:'corrupt-image-safe-fallback',passed:true});
 await assert.rejects(createAttachmentThumbnail(path.join(__dirname,'missing')),{code:'ENOENT'});report.cases.push({case:'missing-file-stays-an-error',passed:true});report.status='passed';
}catch(error){report.status='failed';report.error=error.stack;}finally{if(window)window.destroy();fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify(report,null,2));app.exit(report.status==='passed'?0:1);}});
`;
fs.writeFileSync(path.join(directory, 'driver.cjs'), driver);
const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'COMSPEC'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
for (const name of ['tmp', 'appdata', 'localappdata', 'electron-user-data']) fs.mkdirSync(path.join(directory, name));
Object.assign(env, { TEMP: path.join(directory, 'tmp'), TMP: path.join(directory, 'tmp'), APPDATA: path.join(directory, 'appdata'), LOCALAPPDATA: path.join(directory, 'localappdata') });
const require = createRequire(import.meta.url), fd = fs.openSync(path.join(directory, 'electron.log'), 'wx');
let result;
try { result = spawnSync(require('electron'), ['--user-data-dir=' + path.join(directory, 'electron-user-data'), path.join(directory, 'driver.cjs')], { env, windowsHide: true, stdio: ['ignore', fd, fd], timeout: 120000 }); }
finally { fs.closeSync(fd); }
const report = JSON.parse(fs.readFileSync(path.join(directory, 'result.json')));
fs.writeFileSync(path.join(directory, 'source-receipt.json'), JSON.stringify({ scriptSha256: createHash('sha256').update(fs.readFileSync(import.meta.filename)).digest('hex'), helperSha256: createHash('sha256').update(fs.readFileSync(path.join(root, 'src/main/security/attachmentThumbnail.ts'))).digest('hex'), bundleSha256: createHash('sha256').update(code).digest('hex'), exitCode: result.status, scope: 'Uncommitted working-tree code; synthetic isolated Electron app only, not product-package acceptance' }, null, 2));
assert.equal(result.status, 0, result.error?.message); assert.equal(report.status, 'passed');
console.log(JSON.stringify(report));
});
