import {
  DefaultDetailsViewSection,
  registerDetailsViewSectionsProcessor,
  registerRoute,
  registerSidebarEntry,
} from '@kinvolk/headlamp-plugin/lib';
import { isUnscheduled, PendingExplainer } from './components/PendingExplainer';
import { PendingPodsList } from './components/PendingPodsList';
import type { Pod } from './kube';

const SECTION_ID = 'pending-explainer';

registerDetailsViewSectionsProcessor(function addPendingExplainer(resource, sections) {
  if (resource?.kind !== 'Pod' || !isUnscheduled(resource.jsonData as Pod)) return sections;
  const index = (id: string) =>
    sections.findIndex(s => typeof s === 'object' && s !== null && 'id' in s && s.id === id);
  if (index(SECTION_ID) !== -1) return sections;
  const metadata = index(DefaultDetailsViewSection.METADATA);
  const events = index(DefaultDetailsViewSection.EVENTS);
  const at = metadata !== -1 ? metadata + 1 : events !== -1 ? events : sections.length;
  const next = [...sections];
  next.splice(at, 0, {
    id: SECTION_ID,
    section: <PendingExplainer pod={resource.jsonData as Pod} />,
  });
  return next;
});

registerSidebarEntry({
  parent: 'workloads',
  name: 'pending-pods',
  label: 'Pending Pods',
  url: '/pending-pods',
});

registerRoute({
  path: '/pending-pods',
  sidebar: 'pending-pods',
  name: 'pending-pods',
  exact: true,
  component: () => <PendingPodsList />,
});
