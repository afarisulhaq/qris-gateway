import { expect, test } from 'bun:test';

process.env.DATABASE_PATH = ':memory:';
const { qrisCrc, validateStaticQris, validatePaymentQris } = await import('./qris');
const field = (tag: string, value: string) => tag + String(value.length).padStart(2, '0') + value;
function fixture(method = '11', amount?: number) {
  const value = field('00', '01') + field('01', method)
    + field('51', field('00', 'ID.CO.QRIS.WWW') + field('01', 'TEST-ONLY-NOT-PAYABLE'))
    + field('52', '5812') + field('53', '360') + (amount === undefined ? '' : field('54', String(amount)))
    + field('58', 'ID') + field('59', 'TEST 6304 MERCHANT') + field('60', 'JAKARTA') + '6304';
  return value + qrisCrc(value);
}

test('normalizes the ShopeePay static marker only on an amount-bearing valid payment QR', () => {
  const output = validatePaymentQris(fixture('11', 25000), 25000);
  expect(output.merchant_name).toBe('TEST 6304 MERCHANT');
  expect(output.payload).toBe(fixture('12', 25000));
  expect(validatePaymentQris(output.payload, 25000).payload).toBe(output.payload);
});

test('rejects QR corruption, wrong amounts, and using payment QR as merchant template', () => {
  const payment = fixture('12', 25000);
  expect(() => validatePaymentQris(payment, 25001)).toThrow('nominalnya');
  expect(() => validatePaymentQris(payment.slice(0, -4) + '0000', 25000)).toThrow('tidak valid');
  expect(() => validatePaymentQris(fixture(), 25000)).toThrow('tidak valid');
  expect(() => validateStaticQris(payment)).toThrow('QRIS statis');
});

test('rejects a valid-checksum non-QRIS account and malformed nested TLV', () => {
  const original = fixture();
  const foreign = original.slice(0, -4).replace('ID.CO.QRIS.WWW', 'ID.CO.FAKE.WWW');
  expect(() => validateStaticQris(foreign + qrisCrc(foreign))).toThrow('QRIS statis');
  const broken = original.slice(0, -4).replace('0014ID.CO.QRIS.WWW', '0099ID.CO.QRIS.WWW');
  expect(() => validateStaticQris(broken + qrisCrc(broken))).toThrow('QRIS statis');
});
