export interface Metadata {
  name: string;
  namespace?: string;
  uid?: string;
  labels?: Record<string, string>;
  ownerReferences?: { kind: string; name: string }[];
}

export interface Toleration {
  key?: string;
  operator?: 'Exists' | 'Equal';
  value?: string;
  effect?: '' | 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute';
}

export interface Taint {
  key: string;
  value?: string;
  effect: 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute';
}

export interface LabelSelectorRequirement {
  key: string;
  operator: string;
  values?: string[];
}

export interface LabelSelector {
  matchLabels?: Record<string, string>;
  matchExpressions?: LabelSelectorRequirement[];
}

export interface NodeSelectorTerm {
  matchExpressions?: LabelSelectorRequirement[];
  matchFields?: LabelSelectorRequirement[];
}

export interface PodAffinityTerm {
  labelSelector?: LabelSelector;
  namespaces?: string[];
  topologyKey: string;
}

export interface Container {
  name: string;
  resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
  ports?: { containerPort: number; hostPort?: number; protocol?: string; hostIP?: string }[];
}

export interface Pod {
  metadata: Metadata;
  spec: {
    nodeName?: string;
    nodeSelector?: Record<string, string>;
    tolerations?: Toleration[];
    containers: Container[];
    initContainers?: Container[];
    overhead?: Record<string, string>;
    affinity?: {
      nodeAffinity?: {
        requiredDuringSchedulingIgnoredDuringExecution?: { nodeSelectorTerms: NodeSelectorTerm[] };
      };
      podAffinity?: { requiredDuringSchedulingIgnoredDuringExecution?: PodAffinityTerm[] };
      podAntiAffinity?: { requiredDuringSchedulingIgnoredDuringExecution?: PodAffinityTerm[] };
    };
    volumes?: { name: string; persistentVolumeClaim?: { claimName: string } }[];
  };
  status?: {
    phase?: string;
    conditions?: { type: string; status: string; reason?: string; message?: string }[];
  };
}

export interface Node {
  metadata: Metadata;
  spec?: { unschedulable?: boolean; taints?: Taint[] };
  status?: {
    allocatable?: Record<string, string>;
    conditions?: { type: string; status: string }[];
  };
}

export interface PersistentVolumeClaim {
  metadata: Metadata;
  spec?: { storageClassName?: string; volumeName?: string };
  status?: { phase?: string };
}

export interface StorageClass {
  metadata: Metadata;
  provisioner?: string;
  volumeBindingMode?: string;
}

export interface KubeEvent {
  reason?: string;
  message?: string;
  involvedObject?: { kind?: string; name?: string; namespace?: string; uid?: string };
  lastTimestamp?: string | null;
  eventTime?: string | null;
  metadata?: { creationTimestamp?: string };
}

export interface ClusterState {
  nodes: Node[];
  pods: Pod[];
  pvcs?: PersistentVolumeClaim[];
  storageClasses?: StorageClass[];
  events?: KubeEvent[];
}
