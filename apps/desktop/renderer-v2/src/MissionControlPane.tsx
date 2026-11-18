import React from 'react';
import { missionHeadline, missionProgress, describeStep } from './missionModel';
import type { MissionView, StepView } from './missionModel';

interface Props {
  mission: MissionView;
  onPause?: () => void;
  onStop?: () => void;
  onTakeControl?: () => void;
  onExpandActivity?: () => void;
  onInspectEvidence?: () => void;
  onAllow?: (approvalId: string) => void;
  onDeny?: (approvalId: string) => void;
}

export function MissionControlPane({ mission, onPause, onStop, onTakeControl, onExpandActivity, onInspectEvidence, onAllow, onDeny }: Props) {
  const prog = missionProgress(mission);
  const running = mission.status === 'running';
  return (
    <div className="mission-control">
      <div className="h3" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span className={`dot ${running ? 'running' : mission.status === 'completed' ? 'verified' : mission.status === 'failed' ? 'failed' : 'paused'}`}></span>
        <span style={{ flex: 1 }}>{mission.objective}</span>
        <span className="muted" style={{ fontSize: '11px', fontFamily: 'var(--font-mono)' }}>{prog.done}/{prog.total}</span>
      </div>
      <div className="progress"><div style={{ width: `${prog.percent}%` }}></div></div>
      <div className="muted" style={{ fontSize: '11px', marginTop: '4px', fontFamily: 'var(--font-mono)' }}>
        {mission.status} · {mission.liveActivity ? `${mission.liveActivity.tool} · ${mission.liveActivity.status}` : 'no live activity'}
      </div>

      <div className="timeline" style={{ marginTop: '10px' }}>
        {mission.steps.map((s) => (
          <div className="step" key={s.id}>
            <div className={`agent ${s.kind === 'review' ? 'reviewer' : 'lead'}`}>{s.agentId.slice(0, 2).toUpperCase()}</div>
            <div>
              <div className="title">{s.title}</div>
              <div className="meta">
                {s.agentId} · {describeStep(s, mission, Date.now()).state} — {describeStep(s, mission, Date.now()).sub}
                {s.evidence && s.evidence.verified.length > 0 && (
                  <span> · {s.evidence.verified.map((v) => `${v.tool}×${v.count}`).join(', ')}</span>
                )}
                {s.evidence && s.evidence.unbacked.length > 0 && (
                  <span style={{ color: 'var(--attention)' }}> · not verified: {s.evidence.unbacked.join(', ')}</span>
                )}
              </div>
              {s.artifacts && s.artifacts.length > 0 && (
                <div className="artifacts" style={{ marginTop: '4px' }}>
                  {s.artifacts.map((a, i) => <span className="artifact" key={i}>{a.kind} {a.path.split(/[\\/]/).pop()}</span>)}
                </div>
              )}
            </div>
            <div className={`dot ${s.status === 'succeeded' ? 'verified' : s.status === 'failed' ? 'failed' : s.status === 'running' ? 'running' : 'paused'}`} style={{ marginTop: '6px' }}></div>
          </div>
        ))}
      </div>

      {mission.pendingApprovals.length > 0 && (
        <div style={{ marginTop: '10px' }}>
          {mission.pendingApprovals.map((a) => (
            <div className="approval" key={a.approvalId} style={{ marginBottom: '8px' }}>
              <div className="head"><span className="dot attention"></span><span style={{ fontWeight: 600 }}>Needs your OK · {a.agentName ?? a.toolName}</span></div>
              <div style={{ fontSize: '12px', marginBottom: '6px' }}>{a.text}</div>
              <div className="btns">
                <button className="btn btn-primary" onClick={() => onAllow?.(a.approvalId)}>Allow</button>
                <button className="btn btn-ghost" onClick={() => onDeny?.(a.approvalId)}>Don't allow</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: '6px', marginTop: '12px', flexWrap: 'wrap' }}>
        {running && <button className="btn btn-ghost" onClick={onPause}>⏸ Pause</button>}
        {running && <button className="btn btn-ghost" onClick={onStop}>⏹ Stop</button>}
        <button className="btn btn-ghost" onClick={onTakeControl}>👁 Take control</button>
        <button className="btn btn-ghost" onClick={onExpandActivity}>Expand activity</button>
        <button className="btn btn-ghost" onClick={onInspectEvidence}>Inspect evidence</button>
      </div>
      <div className="muted" style={{ fontSize: '10px', marginTop: '8px', fontFamily: 'var(--font-mono)' }}>
        {mission.workspaceRoot ? `Workspace: ${mission.workspaceRoot}` : 'No workspace'} · {mission.agentNames ? Object.keys(mission.agentNames).length : 0} agents
      </div>
    </div>
  );
}