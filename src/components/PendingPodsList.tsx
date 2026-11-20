import {
  Link,
  Loader,
  SectionBox,
  SimpleTable,
} from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Alert } from '@mui/material';
import { explainPod, summarize } from '../analyze';
import type { Pod } from '../kube';
import { isUnscheduled } from './PendingExplainer';
import { useClusterState } from './useClusterState';

export function PendingPodsList() {
  const { state, error } = useClusterState();
  if (error) return <Alert severity="error">{error}</Alert>;
  if (!state) return <Loader title="Loading pods" />;
  const rows = state.pods.filter(isUnscheduled).map((pod: Pod) => {
    const explanation = explainPod(pod, state);
    const { main, closest } = summarize(explanation, state);
    return { pod, explanation, closest, main };
  });
  return (
    <SectionBox title="Pending pods">
      <SimpleTable
        emptyMessage="No pods are waiting to be scheduled."
        columns={[
          { label: 'Namespace', getter: r => r.pod.metadata.namespace },
          {
            label: 'Pod',
            getter: r => (
              <Link
                routeName="pod"
                params={{ namespace: r.pod.metadata.namespace, name: r.pod.metadata.name }}
              >
                {r.pod.metadata.name}
              </Link>
            ),
          },
          {
            label: 'Main reason',
            getter: r => r.main,
          },
          {
            label: 'Closest node',
            getter: r =>
              r.closest
                ? `${r.closest.node} (${r.closest.blockers.length} blocker${
                    r.closest.blockers.length === 1 ? '' : 's'
                  })`
                : '-',
          },
        ]}
        data={rows}
      />
    </SectionBox>
  );
}
