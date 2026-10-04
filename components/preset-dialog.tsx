"use client";
import { useCallback,useEffect,useRef,useState } from 'react';
import { Bookmark, Pencil, Save, Search, Trash2 } from 'lucide-react';
import { Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription } from '@/components/ui/dialog';
import { AlertDialog,AlertDialogContent,AlertDialogHeader,AlertDialogTitle,AlertDialogDescription,AlertDialogFooter,AlertDialogCancel } from '@/components/ui/alert-dialog';
import { presetStyle,visualModeName,type SavedPreset,type PresetStyle } from '@/lib/presets';
import type { VisualSettings } from '@/lib/visualizer';
type ApiData={error?:string;signin?:string;presets?:SavedPreset[];preset?:SavedPreset;cursor?:string|null};
async function readApiData(response:Response):Promise<ApiData> {
  try{return await response.json() as ApiData;}catch{throw new Error('Could not connect to your preset library. Please try again.');}
}
const errorMessage=(caught:unknown,fallback:string)=>caught instanceof TypeError ? 'Check your connection and try again.' : caught instanceof Error ? caught.message : fallback;
type SaveDraft={id:string;settings:PresetStyle};
export function PresetDialog({open,onOpenChange,settings,onApply,hasMedia,onHelp,onOpenProject}:{open:boolean;onOpenChange:(value:boolean)=>void;settings:VisualSettings;onApply:(preset:SavedPreset)=>void;hasMedia:boolean;onHelp:()=>void;onOpenProject:()=>void}) {
  const [presets,setPresets]=useState<SavedPreset[]>([]),[search,setSearch]=useState(''),[cursor,setCursor]=useState<string|null>(null);
  const [loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[signin,setSignin]=useState<string|null>(null);
  const [draft,setDraft]=useState<SaveDraft|null>(null),[name,setName]=useState(''),[rename,setRename]=useState<SavedPreset|null>(null),[remove,setRemove]=useState<SavedPreset|null>(null),[formError,setFormError]=useState('');
  const requestRef=useRef<AbortController|null>(null);
  const load=useCallback(async(next?:string)=>{
    requestRef.current?.abort();const controller=new AbortController();requestRef.current=controller;
    setLoading(true);setError('');
    try {
      const query=new URLSearchParams({q:search});if(next)query.set('cursor',next);
      const response=await fetch(`/api/presets?${query}`,{signal:controller.signal,cache:'no-store'}),data=await readApiData(response);
      if(controller.signal.aborted)return;
      if(response.status===401){setSignin(data.signin??null);setPresets([]);setCursor(null);return;}
      if(!response.ok)throw new Error(data.error??'Could not load your presets.');
      setSignin(null);setPresets(previous=>next ? [...previous,...(data.presets??[]).filter((item:SavedPreset)=>!previous.some(old=>old.id===item.id))] : (data.presets??[]));setCursor(data.cursor??null);
    }catch(caught){if(!controller.signal.aborted)setError(errorMessage(caught,'Could not load your presets.'));}
    finally {if(!controller.signal.aborted)setLoading(false);}
  },[search]);
  useEffect(()=>{
    if(!open)return;
    const timer=window.setTimeout(()=>{void load();},search ? 220 : 0);
    return ()=>{window.clearTimeout(timer);requestRef.current?.abort();};
  },[open,load,search]);
  const confirmSave=async(event:React.FormEvent)=>{
    event.preventDefault();if(!draft||busy)return;
    setBusy(true);setFormError('');
    try{
      const response=await fetch('/api/presets',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:draft.id,name:name.trim(),settings:draft.settings})}),data=await readApiData(response);
      if(response.status===401)setSignin(data.signin??null);
      if(!response.ok)throw new Error(data.error??'Could not save this preset.');
      if(!data.preset)throw new Error('The preset could not be confirmed. Try again.');
      setDraft(null);setNotice(`Saved “${data.preset.name}”.`);if(search)setSearch('');else await load();
    }catch(caught){setFormError(errorMessage(caught,'Could not save this preset.'));}
    finally{setBusy(false);}
  };
  const confirmRename=async(event:React.FormEvent)=>{
    event.preventDefault();if(!rename||busy)return;setBusy(true);setFormError('');
    try{const response=await fetch(`/api/presets/${rename.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name.trim()})}),data=await readApiData(response);if(response.status===401)setSignin(data.signin??'/signin-with-chatgpt?return_to=%2F%3Fpresets%3D1');if(!response.ok)throw new Error(data.error??'Could not rename this preset.');setRename(null);setNotice('Preset renamed.');await load();}
    catch(caught){setFormError(errorMessage(caught,'Could not rename this preset.'));}finally{setBusy(false);}
  };
  const confirmRemove=async()=>{
    if(!remove||busy)return;setBusy(true);setFormError('');
    try{const response=await fetch(`/api/presets/${remove.id}`,{method:'DELETE'}),data=await readApiData(response);if(response.status===401)setSignin(data.signin??'/signin-with-chatgpt?return_to=%2F%3Fpresets%3D1');if(!response.ok)throw new Error(data.error??'Could not delete this preset.');setRemove(null);setNotice('Preset deleted.');await load();}
    catch(caught){setFormError(errorMessage(caught,'Could not delete this preset.'));}finally{setBusy(false);}
  };
  return <>
    <Dialog open={open} onOpenChange={value=>{if(!busy)onOpenChange(value);}}>
      <DialogContent className="preset-dialog">
        <DialogHeader><div className="dialog-icon"><Bookmark size={20}/></div><DialogTitle>My presets</DialogTitle><DialogDescription>Save your favorite looks and reuse them on any track.</DialogDescription></DialogHeader>
        <div className="preset-library-toolbar"><button className="button button-soft" disabled={loading||!!signin} onClick={()=>{setName('');setFormError('');setDraft({id:crypto.randomUUID(),settings:presetStyle(settings)});}}><Save size={17}/> Save preset</button>
          <label className="preset-search"><Search size={17}/><input aria-label="Search presets" placeholder="Search your presets" maxLength={80} value={search} onChange={event=>setSearch(event.target.value)}/></label></div>
        <p className="preset-note">Visual settings only. Songs, images, subtitle blocks, and track names stay with your project.</p>
        {signin ? <div className="preset-empty"><strong>Keep your looks across devices</strong><p>Sign in with ChatGPT to save and access your own preset library.</p>{hasMedia && <p>Signing in reloads the editor. Save your current project first to keep its media and edits.</p>}<div className="preset-signin-actions">{hasMedia && <button className="button button-soft" onClick={onOpenProject}>Open Project</button>}<a className="button export-button" href={signin} target="_top">Sign in with ChatGPT</a></div></div> : <>
          {error && <div className="preset-error" role="alert"><span>{error}</span><button className="button button-soft" onClick={()=>{void load();}}>Try again</button></div>}
          {notice && <p className="preset-status" role="status">{notice}</p>}
          <div className="preset-list" aria-busy={loading}>
            {!presets.length && !loading && !error && <div className="preset-empty"><strong>{search ? 'No matching presets' : 'Your first look starts here'}</strong><p>{search ? 'Try another name.' : 'Choose Save preset to keep the look currently in your preview.'}</p></div>}
            {presets.map(preset=><article className="preset-card" key={preset.id}>
              <div className="preset-color-preview" aria-hidden="true" style={{background:`linear-gradient(135deg,${preset.settings.primary},${preset.settings.secondary})`}}><span style={{background:preset.settings.background}}/></div>
              <div className="preset-copy"><strong>{preset.name}</strong><span>{visualModeName(preset.settings.mode)}</span></div>
              <button className="button button-soft preset-apply" onClick={()=>{onApply(preset);onOpenChange(false);}}>Apply</button>
              <button className="preset-icon" aria-label={`Rename ${preset.name}`} onClick={()=>{setRename(preset);setName(preset.name);setFormError('');}}><Pencil size={17}/></button>
              <button className="preset-icon" aria-label={`Delete ${preset.name}`} onClick={()=>{setRemove(preset);setFormError('');}}><Trash2 size={17}/></button>
            </article>)}
            {loading && <p className="preset-status" role="status">Loading your presets…</p>}
            {cursor && <button className="button button-soft preset-more" disabled={loading} onClick={()=>{void load(cursor);}}>Load more</button>}
          </div>
        </>}
        <div className="preset-library-footer"><span>No preset count limit.</span><button onClick={onHelp}>How it works</button></div>
      </DialogContent>
    </Dialog>
    <Dialog open={!!draft||!!rename} onOpenChange={value=>{if(!value&&!busy){setDraft(null);setRename(null);}}}>
      <DialogContent className="preset-confirm-dialog" showCloseButton={!busy}>
        <DialogHeader><DialogTitle>{draft ? 'Save this preset?' : 'Rename preset'}</DialogTitle><DialogDescription>{draft ? 'Confirm this look before saving it to your ChatGPT account. Media, images, subtitles, and track names are excluded.' : 'Give this saved look a new name.'}</DialogDescription></DialogHeader>
        <form onSubmit={draft ? confirmSave : confirmRename} className="preset-form">
          <label>Preset name<input autoFocus required maxLength={80} placeholder="e.g. Neon lake" value={name} onChange={event=>setName(event.target.value)} disabled={busy}/></label>
          {draft && <div className="preset-save-summary"><span className="preset-color-preview" aria-hidden="true" style={{background:`linear-gradient(135deg,${draft.settings.primary},${draft.settings.secondary})`}}/><div><strong>{visualModeName(draft.settings.mode)}</strong><p>Colors, motion, audio response, logo layout, and text styling.</p></div></div>}
          {formError && <p className="preset-error" role="alert">{formError}</p>}
          {signin && <div className="preset-signin-recovery"><p>Your sign-in has expired. Close this popup to sign in again.{hasMedia ? " Save your current project first to keep its media and edits." : ""}</p><button type="button" className="button button-soft" onClick={()=>{setDraft(null);setRename(null);}}>Back to library</button></div>}
          <div className="preset-form-actions"><button type="button" className="button button-soft" disabled={busy} onClick={()=>{setDraft(null);setRename(null);}}>Cancel</button><button className="button export-button" disabled={busy||!name.trim()} type="submit">{busy ? 'Saving…' : draft ? 'Confirm save' : 'Save name'}</button></div>
        </form>
      </DialogContent>
    </Dialog>
    <AlertDialog open={!!remove} onOpenChange={value=>{if(!value&&!busy)setRemove(null);}}>
      <AlertDialogContent className="preset-confirm-dialog"><AlertDialogHeader><AlertDialogTitle>Delete this preset?</AlertDialogTitle><AlertDialogDescription>“{remove?.name}” will be removed from your library. Your current visualizer and project stay as they are.</AlertDialogDescription></AlertDialogHeader>
        {formError && <p className="preset-error" role="alert">{formError}</p>}
        {signin && <p className="preset-note">Your sign-in has expired. Cancel to sign in again from your library.</p>}
        <AlertDialogFooter><AlertDialogCancel className="button button-soft" disabled={busy}>Cancel</AlertDialogCancel><button className="button preset-delete" disabled={busy} onClick={()=>{void confirmRemove();}}>{busy?'Deleting…':'Delete preset'}</button></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
