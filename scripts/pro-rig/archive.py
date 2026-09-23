"""Local CMO3 graph IO; no dependency on another project."""
import struct, zlib, xml.etree.ElementTree as ET
import caff

def field(e, name):
    return next(c for c in e if c.get('xs.n') == name)


def deep(e, name):
    return next(c for c in e.iter() if c.get('xs.n') == name)


def name(e):
    return deep(e, 'localName').text


def archive(path):
    data = path.read_bytes(); key = struct.unpack_from('>i', data, 14)[0]
    r = caff._Reader(data); r.pos = 54
    entries = []
    for _ in range(r.int32(key)):
        path, tag = r.string(key), r.string(key)
        start, size = r.int64(key), r.int32(key)
        obf, compression = r.byte(key), r.byte(key); r.skip(8)
        stored = data[start:start+size]
        if obf: stored = bytes(b ^ (key & 255) for b in stored)
        entries.append(dict(path=path, tag=tag, obf=obf, compression=compression, stored=stored))
    xml_entry = next(e for e in entries if e['path'] == 'main.xml')
    packed = xml_entry['stored']
    a, b = struct.unpack_from('<HH', packed, 26)
    xml = zlib.decompress(packed[30+a+b:], -15)
    xml_entry['preamble'] = xml[:xml.index(b'<root')]
    return data[:54], key, entries, ET.fromstring(xml)


def repack(header, key, entries, root):
    # Preserve native header and every unchanged payload exactly after deobfuscation.
    xml = ET.tostring(root, encoding='utf-8')
    entry = next(e for e in entries if e['path'] == 'main.xml')
    xml = entry['preamble'] + xml
    # Rebuild the whole ZIP member. Original files may store CRC and sizes in
    # the local header (no data descriptor); retaining that header after an
    # edit makes Java ZipInputStream reject the new XML with invalid entry size.
    entry['stored'] = caff._zip_wrap(xml, small=entry['compression'] == caff.COMPRESS_SMALL)
    w = caff._Writer(); w.raw(header); w.int32(len(entries), key)
    offsets = []
    for e in entries:
        w.string(e['path'], key); w.string(e['tag'], key)
        offsets.append(len(w)); w.int64(0, key); w.int32(len(e['stored']), key)
        w.byte(e['obf'], key); w.byte(e['compression'], key); w.zeros(8)
    for e, at in zip(entries, offsets):
        w.patch_int64(at, len(w), key)
        w.raw(e['stored'], key if e['obf'] else 0)
    w.raw(b'bc')
    return w.bytes()



