/** Every owned resource gets a cleanup attempt; failures never echo private driver details. */
export async function closeTeachingLiveResources(closers:readonly (()=>Promise<unknown>)[]):Promise<void>{
 let failed=false;
 for(const close of closers){try{await close();}catch{failed=true;}}
 if(failed)throw new Error('Synthetic fixture cleanup incomplete.');
}
