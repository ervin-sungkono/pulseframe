import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { PresetStore } from './preset-store';
const noStore={'Cache-Control':'private, no-store'};
export function presetResponse(body: unknown, status = 200) {return Response.json(body,{status,headers:noStore});}
export async function presetAccess(request: Request, write=false) {
  const user=await getChatGPTUser();
  if(!user) return {error:presetResponse({error:'Sign in to save and reuse your presets.',signin:'/signin-with-chatgpt?return_to=%2F%3Fpresets%3D1'},401)};
  if(write) {
    const origin=request.headers.get('Origin');
    let allowed=request.headers.get('Sec-Fetch-Site')!=='cross-site';
    if(origin) {try{allowed=allowed && new URL(origin).origin===new URL(request.url).origin;}catch{allowed=false;}}
    if(!allowed)return {error:presetResponse({error:'This request could not be verified.'},403)};
  }
  if(!env.DB) throw new Error('Preset storage is unavailable.');
  return {userId:user.userId,store:new PresetStore(env.DB)};
}
export async function readPresetBody(request:Request) {
  if(!request.headers.get('content-type')?.startsWith('application/json')) throw new Error('Use a valid preset name and settings.');
  const reader=request.body?.getReader(); if(!reader) throw new Error('Use a valid preset name and settings.');
  const decoder=new TextDecoder();let bytes=0,text='';
  try {for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>32768){await reader.cancel();throw new Error('This preset is too large.');}text+=decoder.decode(value,{stream:true});}text+=decoder.decode();return JSON.parse(text) as unknown;}
  finally {reader.releaseLock();}
}
export function presetFailure(error:unknown) {console.error('Preset storage request failed',error);return presetResponse({error:'Your presets are unavailable right now. Try again in a moment.'},503);}
