import { uploadResumable, type UploadTransport } from './upload.js'

export async function commitArtifactBeforeFinish(
  bundlePath:string,
  transport:UploadTransport,
  finish:(artifactHash:string)=>Promise<void>,
):Promise<string>{
  const artifactHash=await uploadResumable(bundlePath,transport)
  await finish(artifactHash)
  return artifactHash
}
