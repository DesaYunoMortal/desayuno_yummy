(function (Scratch) {
  'use strict';
  if (!Scratch.extensions.unsandboxed) {
    throw new Error('Discord Presence necesita ejecutarse como extensión sin sandbox en TurboWarp Desktop.');
  }

  const BASE = 'http://127.0.0.1:3210';
  let lastError = '';
  let connected = false;

  async function post(path, data = {}) {
    try {
      const response = await fetch(BASE + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      const result = await response.json();
      if (!response.ok || result.ok === false) throw new Error(result.error || 'Error del puente local');
      lastError = '';
      connected = result.connected !== false;
      return result;
    } catch (e) {
      lastError = String(e.message || e);
      connected = false;
      return { ok: false, error: lastError };
    }
  }

  async function getStatus() {
    try {
      const r = await fetch(BASE + '/status');
      const d = await r.json();
      connected = !!d.connected;
      return d;
    } catch (e) {
      connected = false;
      lastError = String(e.message || e);
      return { connected: false };
    }
  }

  class DiscordPresence {
    getInfo() {
      return {
        id: 'discordpresence',
        name: 'Discord Presence',
        color1: '#5865F2',
        color2: '#4752C4',
        color3: '#303B9B',
        blocks: [
          { opcode: 'connect', blockType: Scratch.BlockType.COMMAND, text: 'conectar a Discord' },
          { opcode: 'setPresence', blockType: Scratch.BlockType.COMMAND,
            text: 'poner detalles [DETAILS] estado [STATE] imagen grande [LARGE] texto grande [LARGETEXT] imagen pequeña [SMALL] texto pequeño [SMALLTEXT]',
            arguments: {
              DETAILS: { type: Scratch.ArgumentType.STRING, defaultValue: 'Jugando a mi juego' },
              STATE: { type: Scratch.ArgumentType.STRING, defaultValue: 'En el menú' },
              LARGE: { type: Scratch.ArgumentType.STRING, defaultValue: 'game_logo' },
              LARGETEXT: { type: Scratch.ArgumentType.STRING, defaultValue: 'Mi juego' },
              SMALL: { type: Scratch.ArgumentType.STRING, defaultValue: '' },
              SMALLTEXT: { type: Scratch.ArgumentType.STRING, defaultValue: '' }
            }
          },
          { opcode: 'setButtons', blockType: Scratch.BlockType.COMMAND,
            text: 'poner botón 1 [LABEL1] URL [URL1] y botón 2 [LABEL2] URL [URL2]',
            arguments: {
              LABEL1: { type: Scratch.ArgumentType.STRING, defaultValue: 'Jugar' },
              URL1: { type: Scratch.ArgumentType.STRING, defaultValue: 'https://example.com' },
              LABEL2: { type: Scratch.ArgumentType.STRING, defaultValue: '' },
              URL2: { type: Scratch.ArgumentType.STRING, defaultValue: '' }
            }
          },
          { opcode: 'startTimer', blockType: Scratch.BlockType.COMMAND, text: 'reiniciar cronómetro de actividad' },
          { opcode: 'clear', blockType: Scratch.BlockType.COMMAND, text: 'quitar Rich Presence' },
          { opcode: 'isConnected', blockType: Scratch.BlockType.BOOLEAN, text: '¿conectado a Discord?' },
          { opcode: 'lastError', blockType: Scratch.BlockType.REPORTER, text: 'último error de Discord' }
        ]
      };
    }

    async connect() {
      await post('/connect');
    }

    async setPresence(args) {
      const data = {
        details: String(args.DETAILS || ''),
        state: String(args.STATE || ''),
        largeImageKey: String(args.LARGE || ''),
        largeImageText: String(args.LARGETEXT || ''),
        smallImageKey: String(args.SMALL || ''),
        smallImageText: String(args.SMALLTEXT || '')
      };
      await post('/presence', data);
    }

    async setButtons(args) {
      const buttons = [];
      if (String(args.LABEL1 || '').trim() && String(args.URL1 || '').trim()) {
        buttons.push({ label: String(args.LABEL1), url: String(args.URL1) });
      }
      if (String(args.LABEL2 || '').trim() && String(args.URL2 || '').trim()) {
        buttons.push({ label: String(args.LABEL2), url: String(args.URL2) });
      }
      await post('/presence', { buttons });
    }

    async startTimer() {
      await post('/presence', { resetTimer: true });
    }

    async clear() {
      await post('/clear');
    }

    async isConnected() {
      const status = await getStatus();
      return !!status.connected;
    }

    lastError() { return lastError; }
  }

  Scratch.extensions.register(new DiscordPresence());
})(Scratch);
