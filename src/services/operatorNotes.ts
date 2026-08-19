import { getRayfinClient } from '@/services/rayfinClient';

export interface OperatorNoteRecord {
  id: string;
  title: string;
  body: string;
  severity: string;
  routeId?: string;
  vehicleId?: string;
  createdAt: Date;
  updatedAt: Date;
  user_id: string;
}

export interface NewOperatorNote {
  title: string;
  body: string;
  severity: string;
  routeId?: string;
  vehicleId?: string;
}

const STORAGE_KEY = 'ttc-digital-twin.operator-notes';
const demoMode = import.meta.env.VITE_DEMO_MODE === 'true';

function readDemoNotes(): OperatorNoteRecord[] {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (!stored) return [];
  try {
    return (JSON.parse(stored) as Array<Omit<OperatorNoteRecord, 'createdAt' | 'updatedAt'> & {
      createdAt: string;
      updatedAt: string;
    }>).map((note) => ({
      ...note,
      createdAt: new Date(note.createdAt),
      updatedAt: new Date(note.updatedAt),
    }));
  } catch {
    return [];
  }
}

function writeDemoNotes(notes: OperatorNoteRecord[]) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
}

export async function listOperatorNotes(): Promise<OperatorNoteRecord[]> {
  if (demoMode) {
    return readDemoNotes().sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  }

  return getRayfinClient().data.OperatorNote.select([
    'id', 'title', 'body', 'severity', 'routeId', 'vehicleId',
    'createdAt', 'updatedAt', 'user_id',
  ])
    .orderBy({ createdAt: 'desc' })
    .first(50)
    .execute();
}

export async function createOperatorNote(
  input: NewOperatorNote,
  userId: string
): Promise<OperatorNoteRecord> {
  const now = new Date();
  if (demoMode) {
    const note: OperatorNoteRecord = {
      id: crypto.randomUUID(),
      ...input,
      createdAt: now,
      updatedAt: now,
      user_id: userId,
    };
    writeDemoNotes([note, ...readDemoNotes()]);
    return note;
  }

  return getRayfinClient().data.OperatorNote.create({
    ...input,
    createdAt: now,
    updatedAt: now,
    user_id: userId,
  });
}

export async function deleteOperatorNote(id: string): Promise<void> {
  if (demoMode) {
    writeDemoNotes(readDemoNotes().filter((note) => note.id !== id));
    return;
  }
  await getRayfinClient().data.OperatorNote.delete({ id });
}