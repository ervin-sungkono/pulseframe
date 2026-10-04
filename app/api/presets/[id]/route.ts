import { z } from 'zod';
import { presetAccess,presetResponse,readPresetBody,presetFailure } from '@/lib/preset-api';
import { presetIdSchema,presetNameSchema,presetStyle,quickLookOrderSchema,presetRevisionSchema } from '@/lib/presets';
import type { PresetStyle } from '@/lib/presets';
import type { PresetMutation } from '@/lib/preset-store';
type Context={params:Promise<{id:string}>};
export const dynamic='force-dynamic';
export async function PATCH(request:Request,context:Context) {
  try {
    const access=await presetAccess(request,true);if(access.error)return access.error;
    const {id}=await context.params;if(!presetIdSchema.safeParse(id).success)return presetResponse({error:'Preset not found.'},404);
    const patchSchema=z.object({
      name:presetNameSchema.optional(),
      settings:z.unknown().optional(),
      pinned:z.boolean().optional(),
      quickLookOrder:quickLookOrderSchema.optional(),
      expectedRevision:presetRevisionSchema,
    }).strict();
    let body:z.infer<typeof patchSchema>;try{body=patchSchema.parse(await readPresetBody(request));}catch{return presetResponse({error:'Enter valid preset changes and the current revision.'},400);}
    const mutationKeys=['name','settings','pinned','quickLookOrder'] as const;
    if(!mutationKeys.some(key=>Object.hasOwn(body,key)))return presetResponse({error:'Choose at least one preset change.'},400);
    let settings:PresetStyle|undefined;
    if(Object.hasOwn(body,'settings')){try{settings=presetStyle(body.settings);}catch{return presetResponse({error:'This look could not be saved. Its settings are invalid.'},400);}}
    const mutation:PresetMutation={expectedRevision:body.expectedRevision};
    if(Object.hasOwn(body,'name'))mutation.name=body.name;
    if(Object.hasOwn(body,'settings'))mutation.settings=settings;
    if(Object.hasOwn(body,'pinned'))mutation.pinned=body.pinned;
    if(Object.hasOwn(body,'quickLookOrder'))mutation.quickLookOrder=body.quickLookOrder;
    const result=await access.store.update(access.userId,id,mutation);
    if(result.status==='missing')return presetResponse({error:'Preset not found.'},404);
    if(result.status==='conflict')return presetResponse({error:'This preset changed in another session. Refresh and try again.',preset:result.preset},409);
    return presetResponse({preset:result.preset});
  } catch(error){return presetFailure(error);}
}
export async function DELETE(request:Request,context:Context) {
  try {
    const access=await presetAccess(request,true);if(access.error)return access.error;
    const {id}=await context.params;if(!presetIdSchema.safeParse(id).success)return presetResponse({error:'Preset not found.'},404);
    return await access.store.remove(access.userId,id) ? presetResponse({deleted:true}) : presetResponse({error:'Preset not found.'},404);
  } catch(error){return presetFailure(error);}
}
