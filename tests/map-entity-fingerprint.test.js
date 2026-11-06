const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function main() {
  const {
    parseMerchantText,
    parseMonGenText,
    updateMerchantNpc,
    updateMonGenFields,
    assertEntityLineFingerprint,
  } = require('../out/utils/map-entities');
  const {
    parseMapMarkerText,
    updateMapMarkerLine,
    deleteMapMarkerLine,
  } = require('../out/utils/map-preview');
  const { entityLineFingerprint } = require('../out/utils/text');

  // Merchant.txt：解析出的 NPC 必须携带行指纹，且指纹在内容变化后失效。
  const merchantText = [
    '\\Market_Def\\武器店-0 3 330 336 武器店老板 0 8 0 0 0',
    '\\Market_Def\\药店-0 0 340 332 药店老板 2 9 0 0 0',
    '',
    '; 注释行',
  ].join('\n');
  const npcs = parseMerchantText(merchantText);
  assert.equal(npcs.length, 2);
  for (const npc of npcs) {
    assert.ok(npc.lineFingerprint, 'parsed npc must carry a line fingerprint');
    assert.equal(npc.lineFingerprint, entityLineFingerprint(merchantText.split('\n')[npc.lineNumber - 1]));
  }

  // 正常更新：指纹匹配则按行号更新成功。
  const updated = updateMerchantNpc(merchantText, 1, 331, 337, 8, undefined, npcs[0].lineFingerprint);
  assert.equal(updated.npc.x, 331);
  assert.equal(updated.npc.y, 337);
  assert.ok(updated.text.includes('\\Market_Def\\武器店-0 3 331 337 武器店老板 0 8 0 0 0'));
  assert.ok(updated.text.includes('\\Market_Def\\药店-0 0 340 332 药店老板 2 9 0 0 0'), 'other lines must stay untouched');

  // 行内容被外部改动后指纹失效：拒绝写入。
  const externallyChanged = merchantText.replace('3 330 336 武器店老板', '3 330 336 武器店老板(已改)');
  assert.throws(
    () => updateMerchantNpc(externallyChanged, 1, 331, 337, 8, undefined, npcs[0].lineFingerprint),
    /第 1 行内容已在地图预览加载后被外部修改/
  );
  // 行号错位（内容相同但行号不同）同样拒绝。
  const shifted = ['', merchantText].join('\n');
  assert.throws(
    () => updateMerchantNpc(shifted, 1, 331, 337, 8, undefined, npcs[0].lineFingerprint),
    /第 1 行/
  );
  // 未携带指纹的旧消息保持兼容。
  assert.doesNotThrow(() => updateMerchantNpc(merchantText, 1, 331, 337, 8));

  // MonGen.txt 同样校验。
  const monGenText = '0 100 100 鸡 5 20 60 0 0 0\r\n0 110 110 鹿 8 15 120 0 0 0\r\n';
  const spawns = parseMonGenText(monGenText);
  assert.equal(spawns.length, 2);
  const fields = spawns[0].fields.slice();
  fields[1] = '101';
  const monGenUpdated = updateMonGenFields(monGenText, 1, fields, spawns[0].lineFingerprint);
  assert.equal(monGenUpdated.spawn.x, 101);
  assert.ok(monGenUpdated.text.includes('0 101 100 鸡 5 20 60 0 0 0'), 'CRLF file must keep its line endings');
  assert.ok(monGenUpdated.text.endsWith('\r\n'), 'trailing CRLF must survive');
  const changedMonGen = monGenText.replace('鸡 5 20', '鸡 9 20');
  assert.throws(
    () => updateMonGenFields(changedMonGen, 1, fields, spawns[0].lineFingerprint),
    /MonGen\.txt 第 1 行/
  );

  // 直接校验助手：行范围切片与解析侧行内容一致。
  assert.doesNotThrow(() => assertEntityLineFingerprint(monGenText, 1, spawns[0].lineFingerprint, 'MonGen.txt'));
  assert.throws(() => assertEntityLineFingerprint('x', 1, spawns[0].lineFingerprint, 'MonGen.txt'));
  assert.doesNotThrow(() => assertEntityLineFingerprint(monGenText, 1, undefined, 'MonGen.txt'));

  // 地图标识：更新/删除都带指纹校验。
  const markerText = '0,100,100,回城点,,0\n0,150,150,药店传送,252,1\n';
  const markers = parseMapMarkerText(markerText);
  assert.equal(markers.length, 2);
  for (const marker of markers) {
    assert.ok(marker.lineFingerprint, 'parsed marker must carry a line fingerprint');
  }
  const markerUpdate = updateMapMarkerLine(
    markerText,
    1,
    { mapName: '0', x: 120, y: 130, text: '回城点', colorSource: '252', mode: 0 },
    markers[0].lineFingerprint
  );
  assert.ok(markerUpdate.text.includes('0,120,130,回城点'), 'marker update must apply');
  assert.throws(
    () => updateMapMarkerLine(
      markerText.replace('回城点', '回城点-改'),
      1,
      { mapName: '0', x: 120, y: 130, text: '回城点', colorSource: '252', mode: 0 },
      markers[0].lineFingerprint
    ),
    /标识文件第 1 行/
  );
  const markerDeleted = deleteMapMarkerLine(markerText, 2, markers[1].lineFingerprint);
  assert.ok(!markerDeleted.text.includes('药店传送'), 'marker deletion must apply');
  assert.throws(
    () => deleteMapMarkerLine(markerText.replace('150,150', '160,160'), 2, markers[1].lineFingerprint),
    /标识文件第 2 行/
  );
  assert.doesNotThrow(() => deleteMapMarkerLine(markerText, 2));

  // 指纹独立于文件编码：GBK 解码后的行与指纹一致时允许写入。
  const iconv = (() => { try { return require('iconv-lite'); } catch { return undefined; } })();
  if (iconv) {
    const gbkBytes = iconv.encode(merchantText, 'gbk');
    const { decodeTextFile } = require('../out/utils/text');
    const decoded = decodeTextFile(gbkBytes);
    assert.equal(decoded.encoding, 'gbk');
    const gbkNpcs = parseMerchantText(decoded.text);
    assert.equal(gbkNpcs[0].lineFingerprint, npcs[0].lineFingerprint, 'fingerprint must survive GBK decode');
    assert.doesNotThrow(() => updateMerchantNpc(decoded.text, 1, 331, 337, 8, undefined, npcs[0].lineFingerprint));
  }

  console.log('map-entity-fingerprint.test.js: PASS');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
