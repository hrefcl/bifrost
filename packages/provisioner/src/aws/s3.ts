import {
  S3Client,
  ListObjectVersionsCommand,
  DeleteObjectsCommand,
  type ObjectIdentifier,
} from '@aws-sdk/client-s3';

/**
 * Vacía un bucket S3 por completo (necesario antes de borrar el stack: CloudFormation no borra un
 * bucket NO vacío → DELETE_FAILED). El bucket de Bifrost tiene VERSIONADO activo, así que hay que
 * borrar TODAS las versiones de objeto + los delete-markers, no sólo las "keys" visibles.
 *
 * Lista y borra en lotes de hasta 1000 (límite de DeleteObjects). Re-lista tras cada lote: drena el
 * bucket sin paginar a mano. Devuelve cuántas versiones/markers se borraron.
 */
export async function emptyBucket(region: string, bucket: string): Promise<number> {
  const s3 = new S3Client({ region });
  let deleted = 0;
  for (;;) {
    let list;
    try {
      list = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, MaxKeys: 1000 }));
    } catch (err) {
      // El bucket ya no existe (borrado en una corrida previa) → nada que vaciar, seguir con el stack.
      // Cualquier OTRO error (AccessDenied, etc.) SÍ se propaga: abortar antes del delete-stack para no
      // dejarlo en DELETE_FAILED por un bucket no vacío.
      const name = (err as { name?: string }).name;
      if (name === 'NoSuchBucket') return deleted;
      throw err;
    }
    const objects: ObjectIdentifier[] = [...(list.Versions ?? []), ...(list.DeleteMarkers ?? [])]
      .filter((o): o is { Key: string; VersionId?: string } => typeof o.Key === 'string')
      .map((o) => ({ Key: o.Key, VersionId: o.VersionId }));
    if (objects.length === 0) break;
    await s3.send(
      new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } })
    );
    deleted += objects.length;
  }
  return deleted;
}
