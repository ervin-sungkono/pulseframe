import { z } from 'zod';
import { presetAccess, presetFailure, presetResponse, readPresetBody } from '@/lib/preset-api';
import { presetIdSchema, presetRevisionSchema } from '@/lib/presets';

const reorderMemberSchema = z.object({
  id: presetIdSchema,
  expectedRevision: presetRevisionSchema,
}).strict();

const reorderSchema = z.object({
  first: reorderMemberSchema,
  second: reorderMemberSchema,
}).strict();

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const access = await presetAccess(request, true);
    if (access.error) return access.error;

    let payload: z.infer<typeof reorderSchema>;
    try {
      payload = reorderSchema.parse(await readPresetBody(request));
    } catch {
      return presetResponse({ error: 'Choose two valid Quick Looks to reorder.' }, 400);
    }

    if (payload.first.id.toLowerCase() === payload.second.id.toLowerCase()) {
      return presetResponse({ error: 'Choose two different Quick Looks.' }, 400);
    }

    const result = await access.store.reorder(access.userId, payload.first, payload.second);
    if (result.status === 'missing') return presetResponse({ error: 'Preset not found.' }, 404);
    if (result.status === 'conflict') {
      return presetResponse({ error: 'These Quick Looks changed. Refresh the list and try again.' }, 409);
    }
    return presetResponse({ presets: result.presets });
  } catch (error) {
    return presetFailure(error);
  }
}
