import {
  Loader,
  SectionBox,
  SimpleTable,
  StatusLabel,
} from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Alert, Box, Typography } from '@mui/material';
import { explainPod, type Explanation, type Fix } from '../analyze';
import type { Pod } from '../kube';
import { useClusterState } from './useClusterState';

export function isUnscheduled(pod: Pod) {
  return !pod.spec?.nodeName && pod.status?.phase === 'Pending';
}

function FixItem({ fix }: { fix: Fix }) {
  return (
    <Box component="li" sx={{ mb: 1.5 }}>
      <Typography variant="body1" sx={{ fontWeight: 600 }}>
        {fix.title}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {fix.detail}
      </Typography>
      {fix.snippet && (
        <Box
          component="pre"
          sx={{
            mt: 0.5,
            p: 1,
            borderRadius: 1,
            bgcolor: 'action.hover',
            fontSize: '0.8rem',
            overflowX: 'auto',
          }}
        >
          {fix.snippet}
        </Box>
      )}
    </Box>
  );
}

export function ExplanationView({ explanation }: { explanation: Explanation }) {
  const everyNodeFits =
    explanation.nodes.length > 0 &&
    explanation.nodes.every(n => n.fits) &&
    !explanation.podLevel.length;
  return (
    <Box>
      {explanation.scheduler && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Scheduler: {explanation.scheduler.raw}
        </Typography>
      )}
      {everyNodeFits && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Every node looks able to run this pod now. The scheduler retries pending pods, so it
          should be placed soon.
        </Alert>
      )}
      {explanation.agreement.checked && !explanation.agreement.matches && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          This analysis differs from the scheduler's last attempt (
          {explanation.agreement.differences.join('; ')}). The cluster may have changed since then,
          or a check is not modelled.
        </Alert>
      )}
      {explanation.fixes.length > 0 && (
        <>
          <Typography variant="h6" sx={{ mb: 1 }}>
            What to change
          </Typography>
          <Box component="ul" sx={{ pl: 2.5, mt: 0, mb: 2 }}>
            {explanation.fixes.map(fix => (
              <FixItem key={fix.title} fix={fix} />
            ))}
          </Box>
        </>
      )}
      {explanation.nodes.length > 0 && (
        <SimpleTable
          columns={[
            { label: 'Node', getter: n => n.node },
            {
              label: 'Result',
              getter: n => (
                <StatusLabel status={n.fits ? 'success' : 'error'}>
                  {n.fits ? 'Fits' : 'Blocked'}
                </StatusLabel>
              ),
            },
            {
              label: 'Why',
              getter: n =>
                n.fits ? (
                  '-'
                ) : (
                  <Box component="ul" sx={{ m: 0, pl: 2 }}>
                    {n.blockers.map((b: { summary: string }) => (
                      <li key={b.summary}>{b.summary}</li>
                    ))}
                  </Box>
                ),
            },
          ]}
          data={explanation.nodes}
        />
      )}
    </Box>
  );
}

export function PendingExplainer({ pod }: { pod: Pod }) {
  const { state, error } = useClusterState(pod.metadata.namespace);
  if (!isUnscheduled(pod)) return null;
  return (
    <SectionBox title="Why is this pod Pending?">
      {error ? (
        <Alert severity="error">{error}</Alert>
      ) : state ? (
        <ExplanationView explanation={explainPod(pod, state)} />
      ) : (
        <Loader title="Checking nodes" />
      )}
    </SectionBox>
  );
}
