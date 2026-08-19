import { useEffect, useState, type FormEvent } from 'react';
import { FilePlus2, Trash2 } from 'lucide-react';

import {
  createOperatorNote,
  deleteOperatorNote,
  listOperatorNotes,
  type OperatorNoteRecord,
} from '@/services/operatorNotes';
import type { VehicleTelemetry } from '@/types/transit';

interface OperatorLogProps {
  userId: string;
  selectedVehicle: VehicleTelemetry | null;
}

export function OperatorLog({ userId, selectedVehicle }: OperatorLogProps) {
  const [notes, setNotes] = useState<OperatorNoteRecord[]>([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [severity, setSeverity] = useState('observation');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void listOperatorNotes().then(setNotes).catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : 'Could not load operator notes.');
    });
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || !body.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const note = await createOperatorNote(
        {
          title: title.trim(),
          body: body.trim(),
          severity,
          routeId: selectedVehicle?.routeId,
          vehicleId: selectedVehicle?.id,
        },
        userId
      );
      setNotes((current) => [note, ...current]);
      setTitle('');
      setBody('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the note.');
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    try {
      await deleteOperatorNote(id);
      setNotes((current) => current.filter((note) => note.id !== id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not delete the note.');
    }
  }

  return (
    <div className="operator-log">
      <form className="note-form" onSubmit={submit}>
        <div className="note-form-heading">
          <FilePlus2 size={16} />
          <span>New operator note</span>
          {selectedVehicle && <span className="context-chip">{selectedVehicle.label}</span>}
        </div>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Short title"
          maxLength={80}
          aria-label="Note title"
        />
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Record an observation or handoff..."
          maxLength={1200}
          rows={3}
          aria-label="Note details"
        />
        <div className="note-form-actions">
          <select value={severity} onChange={(event) => setSeverity(event.target.value)}>
            <option value="observation">Observation</option>
            <option value="attention">Needs attention</option>
            <option value="handoff">Shift handoff</option>
          </select>
          <button type="submit" disabled={saving || !title.trim() || !body.trim()}>
            {saving ? 'Saving...' : 'Save note'}
          </button>
        </div>
      </form>

      {error && <p className="panel-error">{error}</p>}

      <div className="note-list">
        {notes.length === 0 && <p className="empty-panel">No notes for this operator yet.</p>}
        {notes.map((note) => (
          <article className="note-row" key={note.id}>
            <div className="note-row-topline">
              <span className={`note-severity ${note.severity}`}>{note.severity}</span>
              <time>{note.createdAt.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</time>
              <button type="button" onClick={() => void remove(note.id)} aria-label={`Delete ${note.title}`}>
                <Trash2 size={14} />
              </button>
            </div>
            <h3>{note.title}</h3>
            <p>{note.body}</p>
            {(note.routeId || note.vehicleId) && (
              <div className="note-context">
                {note.routeId && <span>Route {note.routeId}</span>}
                {note.vehicleId && <span>Vehicle {note.vehicleId}</span>}
              </div>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}