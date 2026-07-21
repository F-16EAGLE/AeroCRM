/**
 * vcard.js
 * Minimal, dependency-free vCard 3.0/4.0 parser sufficient for populating
 * the Contact form. Not a full spec implementation, but handles the common
 * fields: FN/N, TEL, EMAIL, and X- social fields when present.
 */

const VCardParser = (() => {
  function unfold(text) {
    // vCard folds long lines with a leading space/tab on the continuation.
    return text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
  }

  function splitCards(text) {
    const unfolded = unfold(text);
    const cards = [];
    const re = /BEGIN:VCARD([\s\S]*?)END:VCARD/gi;
    let m;
    while ((m = re.exec(unfolded)) !== null) {
      cards.push(m[1]);
    }
    return cards;
  }

  function parseLine(line) {
    const idx = line.indexOf(':');
    if (idx === -1) return null;
    const rawKey = line.slice(0, idx);
    const rawValue = line.slice(idx + 1).trim();
    const [key, ...params] = rawKey.split(';');
    return { key: key.toUpperCase(), params, value: rawValue };
  }

  function decodeValue(value) {
    return value
      .replace(/\\n/gi, '\n')
      .replace(/\\,/g, ',')
      .replace(/\\;/g, ';')
      .replace(/\\\\/g, '\\');
  }

  const PLATFORM_MAP = {
    CELL: 'phone', HOME: 'phone', WORK: 'phone', VOICE: 'phone',
    WHATSAPP: 'whatsapp', DISCORD: 'discord', INSTAGRAM: 'instagram', SNAPCHAT: 'snapchat',
  };

  function parseCard(cardText) {
    const lines = cardText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const contact = {
      fullName: '',
      contactMethods: [],
      tags: [],
      notes: '',
    };

    for (const rawLine of lines) {
      const parsed = parseLine(rawLine);
      if (!parsed) continue;
      const { key, params, value } = parsed;
      const val = decodeValue(value);

      switch (key) {
        case 'FN':
          contact.fullName = val;
          break;
        case 'N':
          if (!contact.fullName) {
            const parts = val.split(';').filter(Boolean);
            contact.fullName = parts.reverse().join(' ').trim();
          }
          break;
        case 'TEL': {
          const typeParam = params.find((p) => p.toUpperCase().startsWith('TYPE'));
          const type = typeParam ? typeParam.split('=')[1]?.toUpperCase() : 'CELL';
          contact.contactMethods.push({ platform: 'phone', value: val });
          break;
        }
        case 'EMAIL':
          contact.contactMethods.push({ platform: 'email', value: val });
          break;
        case 'NOTE':
          contact.notes = (contact.notes ? contact.notes + '\n' : '') + val;
          break;
        case 'ORG':
          contact.tags.push(val.split(';')[0]);
          break;
        case 'X-SOCIALPROFILE': {
          const typeParam = params.find((p) => p.toUpperCase().startsWith('TYPE'));
          const type = typeParam ? typeParam.split('=')[1]?.toUpperCase() : 'OTHER';
          const platform = PLATFORM_MAP[type] || 'other';
          contact.contactMethods.push({ platform, value: val });
          break;
        }
        default:
          break;
      }
    }

    if (!contact.fullName) contact.fullName = 'Unnamed contact';
    return contact;
  }

  function parse(text) {
    return splitCards(text).map(parseCard);
  }

  return { parse };
})();
