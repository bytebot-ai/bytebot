# Chaos Testing for ByteBot Temporal Worker

This directory contains Chaos Mesh manifests for testing system resilience.

## Prerequisites

1. **Install Chaos Mesh**:
   ```bash
   helm repo add chaos-mesh https://charts.chaos-mesh.org
   kubectl create ns chaos-mesh
   helm install chaos-mesh chaos-mesh/chaos-mesh -n chaos-mesh --version 2.6.0
   ```

2. **Verify Installation**:
   ```bash
   kubectl get pods -n chaos-mesh
   ```

## Test Categories

### Pod Failure Tests (`pod-failure.yaml`)
- **pod-kill**: Sudden pod termination
- **pod-failure**: Pod enters failed state
- **container-kill**: OOMKill simulation

### Network Chaos (`network-chaos.yaml`)
- **delay**: 200ms network latency
- **loss**: 25% packet loss
- **partition**: Network isolation
- **bandwidth**: 1mbps rate limit
- **dns**: DNS resolution failures

### Stress Tests (`stress-chaos.yaml`)
- **cpu-stress**: 80% CPU load
- **memory-stress**: 256MB memory consumption
- **combined-stress**: CPU + memory pressure

### Workflow (`chaos-workflow.yaml`)
- Complete resilience test scenario
- Scheduled weekly testing

## Running Tests

### Individual Tests
```bash
# Apply pod failure chaos
kubectl apply -f test/chaos/pod-failure.yaml

# Monitor chaos experiments
kubectl get podchaos -n bytebot

# Check workflow status during chaos
temporal workflow list --query "WorkflowType='goalRunWorkflow'"

# Remove chaos
kubectl delete -f test/chaos/pod-failure.yaml
```

### Full Workflow
```bash
# Run complete resilience test
kubectl apply -f test/chaos/chaos-workflow.yaml

# Monitor workflow progress
kubectl get workflow temporal-resilience-test -n bytebot -w

# Check events
kubectl describe workflow temporal-resilience-test -n bytebot
```

## Monitoring During Chaos

```bash
# Watch worker pods
kubectl get pods -n bytebot -l app=bytebot-temporal-worker -w

# Check Temporal metrics
kubectl port-forward svc/temporal-frontend 7233:7233 -n temporal
temporal workflow list

# Check Kafka lag
kubectl exec -it core-cluster-kafka-0 -n kafka -- \
  kafka-consumer-groups.sh --bootstrap-server localhost:9092 \
  --describe --group bytebot-consumers
```

## Expected Behaviors

| Chaos Type | Expected Behavior |
|------------|-------------------|
| Pod Kill | Workflow continues on other workers, no data loss |
| Network Delay | Increased latency, activities may timeout and retry |
| Network Partition | Activities fail, Temporal retries when connectivity restored |
| CPU Stress | Slower execution, may trigger activity timeouts |
| Memory Stress | OOMKill possible, workflow resumes on restart |

## Success Criteria

1. **No data loss**: All in-flight workflows complete or resume correctly
2. **Automatic recovery**: System recovers without manual intervention
3. **Event ordering**: Kafka events maintain correct sequence
4. **Graceful degradation**: Error rates increase but system remains available
