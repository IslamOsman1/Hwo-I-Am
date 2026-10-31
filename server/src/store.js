import {mkdirSync, readFileSync, writeFileSync, renameSync} from 'node:fs';
import {join} from 'node:path';

// One Render instance + persistent disk. Publish only after atomic durable commit.
export class RoomStore {
  constructor(directory) {
    mkdirSync(directory, {recursive: true});
    this.file = join(directory, 'rooms.json');
    try {
      const value = JSON.parse(readFileSync(this.file, 'utf8'));
      if (value.schema !== 1 || !Array.isArray(value.rooms)) throw new Error('Unsupported room database');
      this.rooms = new Map(value.rooms.map(room => [room.code, room]));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error; // Never silently erase damaged saved games.
      this.rooms = new Map();
    }
  }
  save(room) {
    const next = new Map(this.rooms); next.set(room.code, room);
    this.commit(next);
  }
  commit(next) {
    writeFileSync(`${this.file}.tmp`, JSON.stringify({schema: 1, rooms: [...next.values()]}), {mode: 0o600, flush: true});
    renameSync(`${this.file}.tmp`, this.file);
    this.rooms = next;
  }
  clean(now) {
    const next = new Map([...this.rooms].filter(([, r]) => now - r.updatedAt < 48 * 60 * 60 * 1000));
    if (next.size !== this.rooms.size) this.commit(next);
  }
}
