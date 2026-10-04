import { presetAccess,presetResponse,readPresetBody,presetFailure } from '@/lib/preset-api';
import { presetIdSchema,presetNameSchema } from '@/lib/presets';
type Context={params:Promise<{id:string}>};
export const dynamic='force-dynamic';
export async function PATCH(request:Request,context:Context) {
  try {
    const access=await presetAccess(request,true);if(access.error)return access.error;
    const {id}=await context.params;if(!presetIdSchema.safeParse(id).success)return presetResponse({error:'Preset not found.'},404);
    let name;try{const body=await readPresetBody(request) as {name?:unknown};name=presetNameSchema.parse(body?.name);}catch{return presetResponse({error:'Enter a name of 1–80 characters.'},400);}
    const preset=await access.store.rename(access.userId,id,name);return preset ? presetResponse({preset}) : presetResponse({error:'Preset not found.'},404);
  } catch(error){return presetFailure(error);}
}
export async function DELETE(request:Request,context:Context) {
  try {
    const access=await presetAccess(request,true);if(access.error)return access.error;
    const {id}=await context.params;if(!presetIdSchema.safeParse(id).success)return presetResponse({error:'Preset not found.'},404);
    return await access.store.remove(access.userId,id) ? presetResponse({deleted:true}) : presetResponse({error:'Preset not found.'},404);
  } catch(error){return presetFailure(error);}
}
