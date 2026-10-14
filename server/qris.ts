import { BusinessError } from './security';

export function qrisCrc(payload: string): string {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0)) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function invalid(): never { throw new BusinessError(400, 'QRIS statis tidak valid. Periksa TLV, CRC, mata uang IDR, dan negara Indonesia.'); }

function parseTlv(payload: string): Map<string, string> {
  const tags = new Map<string, string>();
  let offset = 0;
  while (offset < payload.length) {
    const header = payload.slice(offset, offset + 4);
    if (!/^\d{4}$/.test(header)) invalid();
    const tag = header.slice(0, 2);
    const length = Number(header.slice(2));
    if (!length || offset + 4 + length > payload.length || tags.has(tag)) invalid();
    tags.set(tag, payload.slice(offset + 4, offset + 4 + length));
    offset += 4 + length;
  }
  return tags;
}

function validateQris(value: unknown) {
  if (typeof value !== 'string') invalid();
  const payload = value.trim();
  if (payload.length > 4096 || !/^[\x20-\x7e]+$/.test(payload)) invalid();
  const tags = parseTlv(payload);
  if (!/^6304[0-9a-f]{4}$/i.test(payload.slice(-8)) || [...tags.keys()].at(-1) !== '63') invalid();
  if (qrisCrc(payload.slice(0, -4)) !== tags.get('63')?.toUpperCase()) invalid();
  if (tags.get('53') !== '360' || tags.get('58') !== 'ID' || !/^\d{4}$/.test(tags.get('52') || '')) invalid();
  const merchant_name = tags.get('59')?.trim() || '';
  const city = tags.get('60')?.trim() || '';
  if (!merchant_name || merchant_name.length > 25 || !city || city.length > 15) invalid();
  let qrisAccount = false;
  for (const [tag, value] of tags) {
    if (Number(tag) >= 26 && Number(tag) <= 51) {
      const account = parseTlv(value);
      if (account.get('00') === 'ID.CO.QRIS.WWW') qrisAccount = true;
    }
    if (tag === '62' || tag === '64') parseTlv(value);
  }
  if (!qrisAccount) invalid();
  return { merchant_name, city, payload, tags };
}

export function validateStaticQris(value: unknown): { merchant_name: string; city: string; payload: string } {
  const { merchant_name, city, payload, tags } = validateQris(value);
  if (tags.get('00') !== '01' || (tags.has('01') && tags.get('01') !== '11') || tags.has('54')) invalid();
  return { merchant_name, city, payload };
}

export function validatePaymentQris(value: string, amount: number): { merchant_name: string; city: string; payload: string } {
  try {
    const { merchant_name, city, payload, tags } = validateQris(value);
    const method = tags.get('01');
    if (tags.get('00') !== '01' || (method !== undefined && method !== '11' && method !== '12') || tags.get('54') !== String(amount) || !Number.isSafeInteger(amount) || amount < 1) invalid();
    if (method !== '11') return { merchant_name, city, payload };
    // ShopeePay inserts tag 54 but retains the static initiation marker.
    let offset = 0;
    while (payload.slice(offset, offset + 2) !== '01') offset += 4 + Number(payload.slice(offset + 2, offset + 4));
    const corrected = payload.slice(0, offset + 4) + '12' + payload.slice(offset + 6, -4);
    return { merchant_name, city, payload: corrected + qrisCrc(corrected) };
  } catch {
    throw new BusinessError(502, 'QRIS pembayaran dari gateway tidak valid atau nominalnya tidak sesuai invoice.');
  }
}
