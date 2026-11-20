import { K8s } from '@kinvolk/headlamp-plugin/lib';
import Event from '@kinvolk/headlamp-plugin/lib/K8s/event';
import type { ClusterState } from '../kube';

const { Node, Pod, PersistentVolumeClaim, StorageClass } = K8s.ResourceClasses;

function json<T>(items: { jsonData: unknown }[] | null): T[] | null {
  return items ? (items.map(item => item.jsonData) as T[]) : null;
}

export function useClusterState(namespace?: string): {
  state: ClusterState | null;
  error: string | null;
} {
  const [nodes, nodeError] = Node.useList();
  const [pods, podError] = Pod.useList();
  const [pvcs] = PersistentVolumeClaim.useList(namespace ? { namespace } : {});
  const [storageClasses] = StorageClass.useList();
  const [events] = Event.useList({
    ...(namespace ? { namespace } : {}),
    fieldSelector: 'reason=FailedScheduling',
  });
  const error = nodeError ?? podError;
  if (error) return { state: null, error: error.message ?? String(error) };
  const nodeList = json<ClusterState['nodes'][0]>(nodes);
  const podList = json<ClusterState['pods'][0]>(pods);
  if (!nodeList || !podList) return { state: null, error: null };
  return {
    state: {
      nodes: nodeList,
      pods: podList,
      pvcs: json<NonNullable<ClusterState['pvcs']>[0]>(pvcs) ?? undefined,
      storageClasses:
        json<NonNullable<ClusterState['storageClasses']>[0]>(storageClasses) ?? undefined,
      events: json<NonNullable<ClusterState['events']>[0]>(events) ?? undefined,
    },
    error: null,
  };
}
