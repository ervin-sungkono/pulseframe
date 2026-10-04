import { z } from 'zod';
import { presetAccess,presetResponse,readPresetBody,presetFailure } from '@/lib/preset-api';
import { presetIdSchema,presetNameSchema,presetStyle } from '@/lib/presets';
export const dynamic='force-dynamic';
export async function GET(request:Request) {
  try {
    const access=await presetAccess(request);if(access.error)return access.error;
    const url=new URL(request.url),search=(url.searchParams.get('q')??'').trim();if(search.length>80)return presetResponse({error:'Search must be 80 characters or fewer.'},400);
    const raw=url.searchParams.get('cursor');let cursor: {time:number;id:string}|undefined;
    if(raw){const [time,id]=raw.split(':');if(!/^\d{1,16}$/.test(time)||!presetIdSchema.safeParse(id).success)return presetResponse({error:'Refresh the preset list and try again.'},400);cursor={time:Number(time),id};}
    return presetResponse(await access.store.list(access.userId,search,cursor));
  } catch(error){return presetFailure(error);}
}
export async function POST(request:Request) {
  try {
    const access=await presetAccess(request,true);if(access.error)return access.error;
    let payload;try{payload=z.object({id:presetIdSchema,name:presetNameSchema,settings:z.unknown()}).parse(await readPresetBody(request));}catch{return presetResponse({error:'Enter a name of 1–80 characters and valid settings.'},400);}
    let settings;try{settings=presetStyle(payload.settings);}catch{return presetResponse({error:'This look could not be saved. Its settings are invalid.'},400);}
    return presetResponse({preset:await access.store.save(access.userId,payload.id,payload.name,settings)},201);
  } catch(error){return presetFailure(error);}
}
