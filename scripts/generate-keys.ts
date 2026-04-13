import { writeFileSync, mkdirSync, existsSync } from 'fs';

async function main() {
  const dir = './keys';
  if (!existsSync(dir)) mkdirSync(dir);

  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );

  const privDer = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
  const pubDer = await crypto.subtle.exportKey('spki', keyPair.publicKey);

  const toPem = (der: ArrayBuffer, type: string) => {
    const b64 = Buffer.from(der).toString('base64');
    const lines = b64.match(/.{1,64}/g)!.join('\n');
    return `-----BEGIN ${type}-----\n${lines}\n-----END ${type}-----\n`;
  };

  writeFileSync(`${dir}/private.pem`, toPem(privDer, 'PRIVATE KEY'));
  writeFileSync(`${dir}/public.pem`, toPem(pubDer, 'PUBLIC KEY'));

  console.log('RS256 key pair generated in ./keys/');
}

main();
