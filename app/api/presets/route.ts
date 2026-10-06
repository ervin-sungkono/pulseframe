import { z } from 'zod';
import { presetAccess,presetResponse,readPresetBody,presetFailure } from '@/lib/preset-api';
import { presetIdSchema,presetNameSchema,presetStyle,quickLookOrderSchema } from '@/lib/presets';
import type { PresetCursor } from '@/lib/preset-store';
export const dynamic='force-dynamic';
export async function GET(request:Request) {
  try {
    const access=await presetAccess(request);if(access.error)return access.error;
    const url=new URL(request.url),search=(url.searchParams.get('q')??'').trim();if(search.length>80)return presetResponse({error:'Search must be 80 characters or fewer.'},400);
    const pinnedValue=url.searchParams.get('pinned');
    if(pinnedValue!==null&&pinnedValue!=='1')return presetResponse({error:'Use pinned=1 to view Quick Looks.'},400);
    const pinnedOnly=pinnedValue==='1';
    const raw=url.searchParams.get('cursor');let cursor: PresetCursor|undefined;
    if(raw!==null){const match=/^(\d{1,16}):([0-9a-f-]+)$/i.exec(raw);const value=match?Number(match[1]):NaN;const id=match?.[2];if(!Number.isSafeInteger(value)||value<0||!presetIdSchema.safeParse(id).success)return presetResponse({error:'Refresh the preset list and try again.'},400);cursor={value,id:id!};}
    return presetResponse(await access.store.list(access.userId,search,cursor,pinnedOnly));
  } catch(error){return presetFailure(error);}
}
export async function POST(request:Request) {
  try {
    const access=await presetAccess(request,true);if(access.error)return access.error;
    let payload;try{payload=z.object({id:presetIdSchema,name:presetNameSchema,settings:z.unknown(),pinned:z.boolean().optional(),quickLookOrder:quickLookOrderSchema.optional()}).strict().parse(await readPresetBody(request));}catch{return presetResponse({error:'Enter a name of 1–80 characters and valid settings.'},400);}
    let settings;try{settings=presetStyle(payload.settings);}catch{return presetResponse({error:'This look could not be saved. Its settings are invalid.'},400);}
    const saved=await access.store.saveWithStatus(access.userId,payload.id,payload.name,settings,{pinned:payload.pinned??false,quickLookOrder:payload.quickLookOrder??0});
    if(!saved)return presetResponse({error:'A preset with this id already exists.'},409);
    return presetResponse({preset:saved.preset},saved.created?201:200);
  } catch(error){return presetFailure(error);}
}
