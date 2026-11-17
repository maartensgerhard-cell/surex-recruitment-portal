export default async (req) => {
  const headers = {"Content-Type":"application/json"};
  if (req.method !== "POST") return new Response(JSON.stringify({error:"Method not allowed"}),{status:405,headers});
  try {
    const access = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i,"").trim();
    if (!access) return new Response(JSON.stringify({error:"Sign-in required."}),{status:401,headers});
    const env = process.env;
    const required = [env.SUPABASE_URL,env.SUPABASE_ANON_KEY,env.DROPBOX_APP_KEY,env.DROPBOX_APP_SECRET,env.DROPBOX_REFRESH_TOKEN];
    if (!required.every(Boolean)) throw new Error("A required server environment variable is missing.");
    const common = {apikey:env.SUPABASE_ANON_KEY,Authorization:"Bearer "+access};
    const userRes = await fetch(env.SUPABASE_URL+"/auth/v1/user",{headers:common});
    if (!userRes.ok) return new Response(JSON.stringify({error:"Session invalid. Sign in again."}),{status:401,headers});
    const user = await userRes.json();
    const roleRes = await fetch(env.SUPABASE_URL+"/rest/v1/rpc/get_my_role",{method:"POST",headers:{...common,"Content-Type":"application/json"},body:"{}"});
    if (!roleRes.ok || !["admin","assistant"].includes(await roleRes.json())) return new Response(JSON.stringify({error:"You do not have permission to upload CVs."}),{status:403,headers});
    const form = await req.formData();
    const name = String(form.get("name")||"").trim();
    const file = form.get("file");
    if (!name || name.length>200) return new Response(JSON.stringify({error:"Enter the applicant's full name."}),{status:400,headers});
    if (!file || typeof file.arrayBuffer!=="function" || !file.name || file.size<=0 || file.size>20*1024*1024) return new Response(JSON.stringify({error:"Choose a file up to 20 MB."}),{status:400,headers});
    const clean = value => value.replace(/[<>:"|?*\\x00-\\x1F]/g,"_").replace(/[\\/\\\\]/g,"_").trim().slice(0,120);
    const stamp = new Date().toISOString().replace(/[:.]/g,"-");
    const path = "/SureX Free state/SureX Management/Onboarding/CV Management/"+clean(name)+" - "+stamp+" - "+clean(file.name);
    const basic = Buffer.from(env.DROPBOX_APP_KEY+":"+env.DROPBOX_APP_SECRET).toString("base64");
    const tokenRes = await fetch("https://api.dropbox.com/oauth2/token",{method:"POST",headers:{Authorization:"Basic "+basic,"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"refresh_token",refresh_token:env.DROPBOX_REFRESH_TOKEN})});
    if (!tokenRes.ok) throw new Error("Dropbox authorisation failed.");
    const token = await tokenRes.json();
    const folderPath = "/SureX Free state/SureX Management/Onboarding/CV Management";
    const folderRes = await fetch("https://api.dropboxapi.com/2/files/create_folder_v2",{method:"POST",headers:{Authorization:"Bearer "+token.access_token,"Content-Type":"application/json"},body:JSON.stringify({path:folderPath,autorename:false})});
    if (!folderRes.ok) {
      const folderError = await folderRes.json();
      const summary = folderError?.error_summary || "";
      if (!summary.includes("path/conflict/folder")) throw new Error("Could not create or access the CV Management Dropbox folder.");
    }
    const up = await fetch("https://content.dropboxapi.com/2/files/upload",{method:"POST",headers:{Authorization:"Bearer "+token.access_token,"Content-Type":"application/octet-stream","Dropbox-API-Arg":JSON.stringify({path,mode:"add",autorename:true,mute:false})},body:await file.arrayBuffer()});
    const data = await up.json();
    if (!up.ok) { console.error("Dropbox CV upload",JSON.stringify(data)); throw new Error("Dropbox upload failed. Check that the CV Management folder exists."); }
    return new Response(JSON.stringify({success:true,path:data.path_display||path,uploaded_by:user.id}),{status:200,headers});
  } catch(error) {
    console.error("CV upload",error);
    return new Response(JSON.stringify({error:error.message||"CV upload failed."}),{status:500,headers});
  }
};