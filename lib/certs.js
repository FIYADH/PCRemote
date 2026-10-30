'use strict';
// Local certificate authority for HTTPS (WebCodecs needs a secure context).
// The laptop trusts the CA once; server certs are re-issued automatically when
// the PC's addresses change. The CA carries critical name constraints so it can
// only ever vouch for private-network addresses and local hostnames.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const forge = require('node-forge');

const { pki, asn1 } = forge;

const PERMITTED_IPV4 = [
  ['10.0.0.0', '255.0.0.0'],
  ['172.16.0.0', '255.240.0.0'],
  ['192.168.0.0', '255.255.0.0'],
  ['100.64.0.0', '255.192.0.0'], // CGNAT range (Tailscale)
  ['169.254.0.0', '255.255.0.0'],
  ['127.0.0.0', '255.0.0.0'],
];
const PERMITTED_DNS = ['localhost', 'local', 'ts.net', 'home.arpa', 'lan'];

const ipToInt = (ip) => ip.split('.').reduce((a, o) => (a * 256) + Number(o), 0);
const isPermittedIp = (ip) => PERMITTED_IPV4.some(([net, mask]) =>
  ((ipToInt(ip) & ipToInt(mask)) >>> 0) === ((ipToInt(net) & ipToInt(mask)) >>> 0));

function localNames(extra = {}) {
  const host = os.hostname().toLowerCase();
  const ips = new Set(['127.0.0.1']);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4' && isPermittedIp(a.address)) ips.add(a.address);
  }
  for (const ip of extra.ips || []) if (isPermittedIp(ip)) ips.add(ip);
  const dns = new Set(['localhost', host, `${host}.local`]);
  for (const d of extra.dns || []) if (d) dns.add(d.toLowerCase());
  return { dns: [...dns], ips: [...ips] };
}

const certFingerprint = (cert) =>
  forge.md.sha256.create().update(asn1.toDer(pki.certificateToAsn1(cert)).getBytes()).digest().toHex();

function newKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  return { privateKey: pki.privateKeyFromPem(privateKey), publicKey: pki.publicKeyFromPem(publicKey) };
}

function nameConstraints(hostname) {
  const ctx = (tag, constructed, value) => asn1.create(asn1.Class.CONTEXT_SPECIFIC, tag, constructed, value);
  const subtree = (generalName) => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [generalName]);
  const ipBytes = (ip) => String.fromCharCode(...ip.split('.').map(Number));
  const permitted = [
    ...PERMITTED_IPV4.map(([net, mask]) => subtree(ctx(7, false, ipBytes(net) + ipBytes(mask)))),
    ...[...PERMITTED_DNS, hostname].map((d) => subtree(ctx(2, false, d))),
  ];
  return asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [ctx(0, true, permitted)]);
}

function serial() {
  return '01' + crypto.randomBytes(15).toString('hex'); // positive, 16 bytes
}

function createCa(hostname) {
  const keys = newKeyPair();
  const cert = pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 86400e3);
  cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 86400e3);
  const attrs = [{ name: 'commonName', value: `PCRemote Local CA (${hostname})` }, { name: 'organizationName', value: 'PCRemote' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, pathLenConstraint: 0, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
    { id: '2.5.29.30', critical: true, value: nameConstraints(hostname) },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { cert, key: keys.privateKey };
}

function createServerCert(ca, names) {
  const keys = newKeyPair();
  const cert = pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 86400e3);
  cert.validity.notAfter = new Date(Date.now() + 825 * 86400e3);
  cert.setSubject([{ name: 'commonName', value: names.dns[1] }]);
  cert.setIssuer(ca.cert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectKeyIdentifier' },
    { name: 'authorityKeyIdentifier', keyIdentifier: ca.cert.generateSubjectKeyIdentifier().getBytes() },
    { name: 'subjectAltName', altNames: [...names.dns.map((value) => ({ type: 2, value })), ...names.ips.map((ip) => ({ type: 7, ip }))] },
  ]);
  cert.sign(ca.key, forge.md.sha256.create());
  return { cert, key: keys.privateKey };
}

// A second CA, without name constraints, used only to vouch for the laptop to the
// PC (client authentication). Kept separate from the server CA so the two trust
// directions never interfere.
function createClientCa() {
  const keys = newKeyPair();
  const cert = pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 86400e3);
  cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 86400e3);
  const attrs = [{ name: 'commonName', value: 'PCRemote Device CA' }, { name: 'organizationName', value: 'PCRemote' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, pathLenConstraint: 0, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { cert, key: keys.privateKey };
}

// The laptop's identity. Presenting this (via the installed .p12) is what lets the
// PC recognise the one authorised device; nothing else can complete the handshake.
function createClientCert(clientCa, cn) {
  const keys = newKeyPair();
  const cert = pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 86400e3);
  cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 86400e3);
  cert.setSubject([{ name: 'commonName', value: cn }, { name: 'organizationName', value: 'PCRemote' }]);
  cert.setIssuer(clientCa.cert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', clientAuth: true },
    { name: 'subjectKeyIdentifier' },
    { name: 'authorityKeyIdentifier', keyIdentifier: clientCa.cert.generateSubjectKeyIdentifier().getBytes() },
  ]);
  cert.sign(clientCa.key, forge.md.sha256.create());
  return { cert, key: keys.privateKey };
}

const loadPair = (crt, key) => ({ cert: pki.certificateFromPem(fs.readFileSync(crt, 'utf8')), key: pki.privateKeyFromPem(fs.readFileSync(key, 'utf8')) });

// Wraps the laptop's certificate + private key (chained to the device CA) in a
// password-protected .p12 that Windows/Chrome can import.
function clientP12(clientCert, clientCa, password) {
  const asn = forge.pkcs12.toPkcs12Asn1(clientCert.key, [clientCert.cert, clientCa.cert], password, { algorithm: '3des', friendlyName: 'PCRemote Laptop' });
  return Buffer.from(asn1.toDer(asn).getBytes(), 'binary');
}

// Returns { key, cert, caPem, clientCaPem, clientFingerprint, names } ready for
// https.createServer, creating or refreshing files under dir as needed.
function ensureCertificates(dir, extra = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const f = (n) => path.join(dir, n);
  const names = localNames(extra);

  let ca;
  if (fs.existsSync(f('ca.crt')) && fs.existsSync(f('ca.key'))) {
    ca = loadPair(f('ca.crt'), f('ca.key'));
  } else {
    ca = createCa(names.dns[1]);
    fs.writeFileSync(f('ca.key'), pki.privateKeyToPem(ca.key), { mode: 0o600 });
    fs.writeFileSync(f('ca.crt'), pki.certificateToPem(ca.cert));
    for (const n of ['server.crt', 'server.key', 'server.json']) fs.rmSync(f(n), { force: true });
  }

  let clientCa;
  if (fs.existsSync(f('clientca.crt')) && fs.existsSync(f('clientca.key'))) {
    clientCa = loadPair(f('clientca.crt'), f('clientca.key'));
  } else {
    clientCa = createClientCa();
    fs.writeFileSync(f('clientca.key'), pki.privateKeyToPem(clientCa.key), { mode: 0o600 });
    fs.writeFileSync(f('clientca.crt'), pki.certificateToPem(clientCa.cert));
  }

  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(f('server.json'), 'utf8')); } catch { /* none yet */ }
  const covered = meta && names.dns.every((d) => meta.dns.includes(d)) && names.ips.every((ip) => meta.ips.includes(ip));
  const fresh = meta && meta.notAfter - Date.now() > 30 * 86400e3;
  if (!covered || !fresh || !fs.existsSync(f('server.crt'))) {
    // Keep previously seen addresses so switching networks back and forth doesn't churn certs.
    const merged = meta ? { dns: [...new Set([...names.dns, ...meta.dns])], ips: [...new Set([...names.ips, ...meta.ips.filter(isPermittedIp)])] } : names;
    const leaf = createServerCert(ca, merged);
    fs.writeFileSync(f('server.key'), pki.privateKeyToPem(leaf.key), { mode: 0o600 });
    fs.writeFileSync(f('server.crt'), pki.certificateToPem(leaf.cert) + pki.certificateToPem(ca.cert));
    fs.writeFileSync(f('server.json'), JSON.stringify({ ...merged, notAfter: leaf.cert.validity.notAfter.getTime() }, null, 2));
  }

  const clientFingerprint = fs.existsSync(f('client.crt'))
    ? certFingerprint(pki.certificateFromPem(fs.readFileSync(f('client.crt'), 'utf8'))) : null;

  return {
    key: fs.readFileSync(f('server.key')),
    cert: fs.readFileSync(f('server.crt')),
    caPem: fs.readFileSync(f('ca.crt')),
    clientCaPem: fs.readFileSync(f('clientca.crt')),
    clientFingerprint,
    names,
  };
}

// Issues (or re-issues) the laptop's certificate and writes a ready-to-run
// enrollment folder: the .p12, the CA, a one-click installer, and instructions.
// Returns { fingerprint, dir, password } so the host can enrol the fingerprint.
function buildLaptopBundle(dir, outDir, opts = {}) {
  const f = (n) => path.join(dir, n);
  ensureCertificates(dir); // makes sure both CAs exist
  const clientCa = loadPair(f('clientca.crt'), f('clientca.key'));

  let client;
  if (!opts.regenerate && fs.existsSync(f('client.crt')) && fs.existsSync(f('client.key'))) {
    client = loadPair(f('client.crt'), f('client.key'));
  } else {
    client = createClientCert(clientCa, opts.name || 'PCRemote Laptop');
    fs.writeFileSync(f('client.key'), pki.privateKeyToPem(client.key), { mode: 0o600 });
    fs.writeFileSync(f('client.crt'), pki.certificateToPem(client.cert));
  }

  const password = crypto.randomBytes(9).toString('base64url');
  const p12 = clientP12(client, clientCa, password);

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const o = (n) => path.join(outDir, n);
  fs.copyFileSync(f('ca.crt'), o('PCRemote-CA.crt'));
  fs.writeFileSync(o('pcremote-laptop.p12'), p12);
  fs.writeFileSync(o('install-on-laptop.bat'), laptopInstaller(password), { encoding: 'latin1' });
  fs.writeFileSync(o('README.txt'), laptopReadme(), { encoding: 'utf8' });

  return { fingerprint: certFingerprint(client.cert), dir: outDir, password };
}

function laptopInstaller(password) {
  return [
    '@echo off',
    'rem Installs the PCRemote certificate so ONLY this laptop can reach your PC.',
    'cd /d "%~dp0"',
    'echo Installing the PCRemote trust certificate (click Yes if Windows asks)...',
    'certutil -user -f -addstore Root "PCRemote-CA.crt"',
    'echo Installing this laptop^\'s identity certificate...',
    `certutil -user -f -p "${password}" -importpfx My "pcremote-laptop.p12" NoRoot`,
    'echo.',
    'echo Done. Close every Chrome and Edge window, reopen, and go to the PCRemote address.',
    'pause',
  ].join('\r\n') + '\r\n';
}

function laptopReadme() {
  return [
    'PCRemote — laptop setup (do this once)',
    '======================================',
    '',
    '1. Double-click  install-on-laptop.bat',
    '2. If Windows asks to trust the certificate, click Yes.',
    '3. Close ALL Chrome/Edge windows, then reopen the browser.',
    '4. Open the PCRemote address (your PC name on Tailscale).',
    '',
    'After this, only THIS laptop can connect to the PC. No other device can,',
    'even with the password. Keep this folder private — delete it once installed.',
    '',
    'To move access to another laptop later, run set-password.bat / re-enroll on the PC.',
  ].join('\r\n') + '\r\n';
}

module.exports = { ensureCertificates, buildLaptopBundle, localNames, certFingerprint };
