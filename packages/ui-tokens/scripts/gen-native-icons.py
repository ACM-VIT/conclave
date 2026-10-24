#!/usr/bin/env python3
"""Finite offline Material Symbols converter. Standard library only; never network I/O.

Reads the closed build-time manifest and the vendored original SVG bytes, validates
everything before any write, converts each path to absolute M/L/Q/Z operations with
exact decimal arithmetic and emits lazy Kotlin ImageVectors plus native iOS symbol
string constants. `--check` is read-only and reports missing, stale or extra outputs.
"""
import argparse
from fractions import Fraction
import hashlib
import json
import math
import os
from pathlib import Path
import re
import struct
import sys
import tempfile
from xml.parsers import expat

ROOT = Path(__file__).resolve().parents[3]
GENERATOR = 'packages/ui-tokens/scripts/gen-native-icons.py'
ICON = Path('packages/ui-tokens/icons')
VENDOR = ICON / 'vendor/material-symbols'
EVIDENCE = ICON / 'semantics-evidence'
ANDROID = Path('apps/conclave-skip/Sources/Conclave/Skip/ui/icons')
IOS = Path('apps/conclave-skip/Sources/Conclave/DesignSystem/iOS/Icons')
IOS_LICENSE = Path('apps/conclave-skip/Sources/Conclave/Resources/MaterialSymbols-LICENSE.txt')
ANDROID_LICENSE = Path('apps/conclave-skip/Android/app/src/main/assets/MaterialSymbols-LICENSE.txt')
REPORT = ICON / 'generated-report.json'
SCHEMA_VERSION = 2
PROFILE = 'material-rounded-24-absolute-v1'
PIN = '49d4db35df873165d6bd6ba09b063c7dafbac2f4'
VENDOR_SEAL_SHA = '8e27e9055db4a2128410afc01ae8334aaa6d30bea557a289e20f4bf4d5e7f3b3'
INDEX_SHA = '42a3b5bd0ae098075bd0bbb16db5fcf03d585c9ce7901f6e1bbfa24554cf17ec'
PROVENANCE_SHA = '67b62c5faf15a2025e9d428ba4d553db4741b4527b0f60f2f31625da5c79d009'
LICENSE_SHA = '58d1e17ffe5109a7ae296caafcadfdbe6a7d176f0bc4ab01e12a689b0499d8bd'
# Sealed archived construction/patch records that restored the per-binding semantics.
# Documentary only: the generator checks their bytes and never parses them.
SEMANTICS_EVIDENCE = {
    'manifest-activity-0-47.json': '44544714d71994e9ffc00c195a1f357748e2a16fbd246dd7626bbd4df3ef671d',
    'manifest-activity-0-59.json': '662bca985e8832210244cda74a76ec596729f65c1195c1e08686ae6d8c4ffee2',
    'manifest-activity-0-83.json': 'd7c79d8ed07aac7f9a993cd833273cdc8edb9e8e3cfe8dc110d37c501673a719',
}
COUNTS = {'concepts': 36, 'material_names': 48, 'artwork': 54, 'bindings': 58, 'sf_literals': 50}
MIRRORED = ('arrow_back.fill0', 'send.fill1')
ROLES = ('button', 'switch', 'checkbox', 'status', 'decorative')
LABELED_ROLES = ('button', 'switch', 'checkbox')
FILL_BASES = ('requirement', 'derived_requirement', 'recommendation')
SYSTEM_KINDS = ('route_picker', 'system_navigation_back', 'system_close')
POLICY_KEYS = ('owner android_child_contentDescription ios_child_accessibility_hidden '
               'standalone_meaningful_image share_control status disabled_or_busy context_labels '
               'no_raw_key_spoken roles state_only_style')
NUMBER = re.compile(r'[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?')
COMMANDS = 'MmLlHhVvQqTtZz'
ARITY = {'M': 2, 'L': 2, 'H': 1, 'V': 1, 'Q': 4, 'T': 2}
MAX_BYTES, MAX_NUMBER, MAX_SEGMENTS, MAX_EXPONENT = 131072, 128, 10000, 512
SEPARATORS = ' \t\r\n'
XML_WHITESPACE = ' \t\r\n'  # the XML 1.0 S production; str.strip() would also drop U+00A0 and U+3000
DASHES = (chr(0x2013), chr(0x2014))  # en and em dash


class IconError(ValueError):
    def __init__(self, code, reason, pointer='/', asset='', offset=None):
        self.details = dict(code=code, pointer=pointer, asset=asset, offset=offset, reason=reason)
        super().__init__(json.dumps(self.details, sort_keys=True))


def require(ok, reason, code='E_SCHEMA', pointer='/', asset='', offset=None):
    if not ok:
        raise IconError(code, reason, pointer, asset, offset)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def strict_json(data):
    def pairs(items):
        out = {}
        for key, value in items:
            require(key not in out, 'duplicate JSON key: ' + key)
            out[key] = value
        return out

    def nonfinite(value):
        raise IconError('E_SCHEMA', 'nonfinite number ' + value)

    try:
        return json.loads(data, object_pairs_hook=pairs, parse_constant=nonfinite)
    except (UnicodeError, json.JSONDecodeError) as error:
        raise IconError('E_SCHEMA', str(error)) from error


def keys(value, expected, pointer):
    require(type(value) is dict and set(value) == set(expected.split()), 'unknown or missing fields', pointer=pointer)


def text(value, pointer, nullable=False):
    if nullable and value is None:
        return
    require(type(value) is str and value.strip() == value and value, 'expected trimmed nonempty string', pointer=pointer)
    require(not any(ord(c) < 32 or c in DASHES for c in value), 'control character or dash in emitted text', pointer=pointer)


def safe(root, relative):
    path = Path(relative)
    require(not path.is_absolute() and '..' not in path.parts and path.parts and str(path) == str(relative),
            'path escape', 'E_INPUT', asset=str(relative))
    current = root
    for part in path.parts:
        current = current / part
        require(not current.is_symlink(), 'symlink forbidden', 'E_INPUT', asset=str(relative))
    return current


# Finder writes these into any folder it opens. They can never be an input or an output, so they never
# count as one (review D3); every other stray file still fails validation and the drift check.
IGNORED_NAMES = {'.DS_Store'}


def listed(directory):
    return {str(p.relative_to(directory)) for p in directory.rglob('*')
            if (p.is_file() or p.is_symlink()) and p.name not in IGNORED_NAMES}


# ---------------------------------------------------------------- strict SVG profile

def svg_path(data, asset='fixture'):
    require(len(data) <= MAX_BYTES, 'SVG exceeds byte bound', 'E_SVG_PROFILE', asset=asset)
    require(b'&' not in data, 'entities/references forbidden', 'E_SVG_PROFILE', asset=asset)
    parser = expat.ParserCreate()
    stack, paths = [], []

    def fail(*_):
        raise IconError('E_SVG_PROFILE', 'DTD, entity, PI, comment, CDATA or XML declaration forbidden',
                        asset=asset, offset=parser.CurrentByteIndex)

    def start(name, attrs):
        if not stack:
            require(name == 'svg' and attrs == {'xmlns': 'http://www.w3.org/2000/svg', 'width': '24',
                                                'height': '24', 'viewBox': '0 -960 960 960'},
                    'unexpected SVG root or attributes', 'E_SVG_PROFILE', asset=asset, offset=parser.CurrentByteIndex)
        else:
            require(stack == ['svg'] and name == 'path' and set(attrs) == {'d'} and not paths,
                    'expected one direct path with only d', 'E_SVG_PROFILE', asset=asset, offset=parser.CurrentByteIndex)
            paths.append(attrs['d'])
        stack.append(name)

    def characters(value):
        require(not value.strip(XML_WHITESPACE), 'text content forbidden', 'E_SVG_PROFILE', asset=asset,
                offset=parser.CurrentByteIndex)

    parser.StartElementHandler = start
    parser.EndElementHandler = lambda name: stack.pop()
    parser.CharacterDataHandler = characters
    for handler in ['StartDoctypeDeclHandler', 'EntityDeclHandler', 'ExternalEntityRefHandler',
                    'ProcessingInstructionHandler', 'CommentHandler', 'StartCdataSectionHandler', 'XmlDeclHandler']:
        setattr(parser, handler, fail)
    try:
        parser.Parse(data, True)
    except expat.ExpatError as error:
        raise IconError('E_SVG_PROFILE', str(error), asset=asset, offset=parser.ErrorByteIndex) from error
    require(len(paths) == 1, 'missing path', 'E_SVG_PROFILE', asset=asset)
    return paths[0]


def tokens(path, asset):
    result, pos, previous = [], 0, None
    while pos < len(path):
        if path[pos] in SEPARATORS:
            pos += 1
            continue
        if path[pos] == ',':
            require(previous == 'number', 'misplaced comma', 'E_PATH', asset=asset, offset=pos)
            pos += 1
            while pos < len(path) and path[pos] in SEPARATORS:
                pos += 1
            require(pos < len(path) and NUMBER.match(path, pos) is not None, 'comma must precede a number',
                    'E_PATH', asset=asset, offset=pos)
            previous = 'comma'
            continue
        if path[pos] in COMMANDS:
            result.append((path[pos], pos))
            pos += 1
            previous = 'command'
        else:
            match = NUMBER.match(path, pos)
            require(match is not None, 'unsupported command or number', 'E_PATH', asset=asset, offset=pos)
            value = match.group()
            require(len(value) <= MAX_NUMBER, 'numeric token exceeds bound', 'E_PATH', asset=asset, offset=pos)
            exponent = re.search(r'[eE]([+-]?[0-9]+)$', value)
            require(exponent is None or abs(int(exponent[1])) <= MAX_EXPONENT,
                    'decimal exponent exceeds bounded profile', 'E_PATH', asset=asset, offset=pos)
            result.append((Fraction(value), pos))
            pos = match.end()
            previous = 'number'
        require(len(result) <= MAX_SEGMENTS * 5, 'token bound exceeded', 'E_PATH', asset=asset, offset=pos)
    return result


def normalize(path, asset='fixture'):
    """Interpret in source coordinates, then translate absolute points by (0,+960)."""
    ts = tokens(path, asset)
    require(ts and ts[0][0] in ('M', 'm'), 'path must start with moveto', 'E_PATH', asset=asset, offset=0)
    result, index, command = [], 0, None
    x = y = Fraction(0)
    start = (x, y)
    control = None
    while index < len(ts):
        value, offset = ts[index]
        if isinstance(value, str):
            command = value
            index += 1
            if command in 'Zz':
                result.append(('Z',))
                x, y = start
                control = None
                command = None
                require(len(result) <= MAX_SEGMENTS, 'segment bound exceeded', 'E_PATH', asset=asset, offset=offset)
                continue
            require(index < len(ts) and isinstance(ts[index][0], Fraction), 'command without operands',
                    'E_PATH', asset=asset, offset=offset)
            continue
        require(command is not None, 'arguments after close', 'E_PATH', asset=asset, offset=offset)
        upper = command.upper()
        count = ARITY[upper]
        group = ts[index:index + count]
        require(len(group) == count and all(isinstance(t[0], Fraction) for t in group), 'incomplete operand group',
                'E_PATH', asset=asset, offset=offset)
        args = [t[0] for t in group]
        index += count
        bx, by = (x, y) if command.islower() else (Fraction(0), Fraction(0))
        if upper in ('M', 'L'):
            x, y = args[0] + bx, args[1] + by
            result.append((upper, x, y + 960))
            control = None
            if upper == 'M':
                start = (x, y)
                command = 'l' if command.islower() else 'L'
        elif upper in ('H', 'V'):
            if upper == 'H':
                x = args[0] + bx
            else:
                y = args[0] + by
            result.append(('L', x, y + 960))
            control = None
        else:
            if upper == 'Q':
                cx, cy, x2, y2 = args[0] + bx, args[1] + by, args[2] + bx, args[3] + by
            else:
                cx, cy = (2 * x - control[0], 2 * y - control[1]) if control is not None else (x, y)
                x2, y2 = args[0] + bx, args[1] + by
            x, y = x2, y2
            result.append(('Q', cx, cy + 960, x, y + 960))
            control = (cx, cy)
        require(len(result) <= MAX_SEGMENTS, 'segment bound exceeded', 'E_PATH', asset=asset, offset=offset)
    return result


def float_literal(value, asset):
    """Nearest binary32 (ties to even) of an exact rational, as a round-trip Kotlin literal."""
    try:
        number = struct.unpack('!f', struct.pack('!f', float(value)))[0]
    except (OverflowError, struct.error) as error:
        raise IconError('E_PATH', 'coordinate outside finite Float32', asset=asset) from error
    require(math.isfinite(number), 'coordinate outside finite Float32', 'E_PATH', asset=asset)
    # Correct any double rounding from Fraction -> binary64 -> binary32 by selecting the
    # closest exact binary32 neighbour (ties to an even significand).
    target = abs(value)
    bits = struct.unpack('!I', struct.pack('!f', abs(number)))[0]
    candidates = []
    for candidate in range(max(0, bits - 1), min(0x7f7fffff, bits + 1) + 1):
        f = struct.unpack('!f', struct.pack('!I', candidate))[0]
        candidates.append((abs(Fraction(f) - target), candidate & 1, f))
    number = min(candidates)[2] * (-1 if value < 0 else 1)
    # Nine significant digits round-trip every binary32; Kotlin parses the literal as Float.
    literal = format(number, '.9g') if number else '0'
    if '.' not in literal and 'e' not in literal:
        literal += '.0'
    return literal + 'f', abs(Fraction(number) - value)


# ---------------------------------------------------------------- manifest validation

def validate_concepts(m, idx, artwork_ids, labels_forbidden):
    used = set()
    total = 0
    require(type(m['concepts']) is list and len(m['concepts']) == len(idx['concepts']) == COUNTS['concepts'],
            'concept inventory mismatch', pointer='/concepts')
    seen = set()
    for i, (c, original) in enumerate(zip(m['concepts'], idx['concepts'])):
        ptr = f'/concepts/{i}'
        keys(c, 'id concept canonical_sf_cell canonical_material_cell canonical_label_cell sf_symbols ios_system bindings', ptr)
        for field in ['id', 'concept', 'canonical_sf_cell', 'canonical_material_cell', 'canonical_label_cell']:
            require(c[field] == original[field], 'concept identity differs from accepted selection: ' + field, pointer=ptr)
        require(re.fullmatch('[a-z][a-z0-9_]*', c['id']) and c['id'] not in seen, 'duplicate or invalid concept', 'E_ID', ptr)
        seen.add(c['id'])
        text(c['concept'], ptr + '/concept')
        require(type(c['sf_symbols']) is list and [s.get('name') if type(s) is dict else None for s in c['sf_symbols']]
                == original['sf_literals'], 'unexplained or missing SF literal', pointer=ptr + '/sf_symbols')
        for j, symbol in enumerate(c['sf_symbols']):
            keys(symbol, 'name context', f'{ptr}/sf_symbols/{j}')
            text(symbol['context'], f'{ptr}/sf_symbols/{j}/context')
        require(type(c['ios_system']) is list, 'ios_system must be a list', pointer=ptr)
        kinds = []
        for j, system in enumerate(c['ios_system']):
            keys(system, 'kind policy', f'{ptr}/ios_system/{j}')
            require(system['kind'] in SYSTEM_KINDS, 'unknown system-owned kind', pointer=f'{ptr}/ios_system/{j}')
            text(system['policy'], f'{ptr}/ios_system/{j}/policy')
            kinds.append(system['kind'])
        require(len(kinds) == len(set(kinds)), 'duplicate system-owned kind', pointer=ptr)
        require(bool(c['sf_symbols']) or bool(c['ios_system']), 'concept has no iOS representation', pointer=ptr)
        require(type(c['bindings']) is list and [(b.get('state'), b.get('artwork')) if type(b) is dict else None
                                                 for b in c['bindings']]
                == [(b['state'], b['artwork_id']) for b in original['android_bindings']],
                'context binding changed', 'E_ID', ptr)
        states = set()
        for j, b in enumerate(c['bindings']):
            bp = f'{ptr}/bindings/{j}'
            keys(b, 'state artwork fill_basis decision_id references accessibility', bp)
            require(re.fullmatch('[a-z][a-z0-9_]*', b['state']) and b['state'] not in states, 'duplicate or invalid state', 'E_ID', bp)
            states.add(b['state'])
            require(b['artwork'] in artwork_ids, 'binding to undeclared artwork', 'E_ID', bp)
            used.add(b['artwork'])
            require(b['fill_basis'] in FILL_BASES, 'invalid fill basis', pointer=bp)
            if b['fill_basis'] == 'requirement':
                require(b['decision_id'] is None, 'numbered requirement cannot cite a decision', pointer=bp)
            else:
                require(b['decision_id'] in m['decisions'], 'undeclared fill: missing accepted decision', pointer=bp)
            require(type(b['references']) is list and b['references'] and all(
                type(r) is str and re.fullmatch('(F00|S10|S20|S30|S40|S50|S60):[1-9][0-9]*', r) for r in b['references']),
                'invalid spec references', pointer=bp)
            a = b['accessibility']
            keys(a, 'label value role icon_exposure', bp + '/accessibility')
            require(a['role'] in ROLES and a['icon_exposure'] == 'decorative_in_labeled_owner',
                    'invalid role or icon exposure', pointer=bp)
            text(a['label'], bp + '/accessibility/label', nullable=True)
            text(a['value'], bp + '/accessibility/value', nullable=True)
            # Controls carry an owner label; status and decoration merge with adjacent copy.
            require((a['label'] is not None) == (a['role'] in LABELED_ROLES), 'owner label/role mismatch', pointer=bp)
            require(a['label'] not in labels_forbidden, 'raw glyph identifier used as label', pointer=bp)
            total += 1
    require(total == COUNTS['bindings'], 'binding count', pointer='/concepts')
    require(used == artwork_ids, 'selected artwork without a binding', 'E_INPUT', pointer='/artwork')


def validate(root):
    manifest_bytes = safe(root, ICON / 'manifest.json').read_bytes()
    m = strict_json(manifest_bytes)
    keys(m, 'schema_version profile source_revision vendor_files semantics_evidence decisions accessibility '
            'history concepts artwork sf_literals', '/')
    require(type(m['schema_version']) is int and m['schema_version'] == SCHEMA_VERSION and m['profile'] == PROFILE
            and m['source_revision'] == PIN, 'unsupported schema/profile/pin')

    vendor = safe(root, VENDOR)
    require(type(m['vendor_files']) is dict and digest(canonical(m['vendor_files'])) == VENDOR_SEAL_SHA,
            'accepted provenance file set changed', 'E_PROVENANCE', '/vendor_files')
    actual = listed(vendor)
    require(actual == set(m['vendor_files']), 'missing/unused vendor input', 'E_INPUT', '/vendor_files')
    for name, h in m['vendor_files'].items():
        require(type(h) is str and re.fullmatch('[a-f0-9]{64}', h), 'invalid hash', 'E_HASH', asset=name)
        require(digest(safe(vendor, name).read_bytes()) == h, 'changed vendored source/provenance', 'E_HASH', asset=name)
    evidence = safe(root, EVIDENCE)
    require(m['semantics_evidence'] == SEMANTICS_EVIDENCE and listed(evidence) == set(SEMANTICS_EVIDENCE),
            'semantics evidence set changed', 'E_PROVENANCE', '/semantics_evidence')
    for name, h in SEMANTICS_EVIDENCE.items():
        require(digest(safe(evidence, name).read_bytes()) == h, 'changed semantics evidence', 'E_HASH', asset=name)

    def pinned(name, h):
        data = safe(vendor, name).read_bytes()
        require(digest(data) == h, 'accepted pin mismatch', 'E_HASH', asset=name)
        return strict_json(data)

    idx = pinned('selected-input-index.json', INDEX_SHA)
    prov = pinned('provenance-manifest.json', PROVENANCE_SHA)
    require(digest(safe(vendor, 'upstream/LICENSE').read_bytes()) == LICENSE_SHA, 'full Apache license changed', 'E_LICENSE')

    require(type(m['artwork']) is list and len(m['artwork']) == COUNTS['artwork'] and type(m['sf_literals']) is list
            and len(m['sf_literals']) == COUNTS['sf_literals'], 'finite inventory mismatch')
    require(m['sf_literals'] == idx['sf_literals'] == sorted(set(idx['sf_literals'])), 'unexplained SF literal', pointer='/sf_literals')
    for i, a in enumerate(m['artwork']):
        keys(a, 'id name fill autoMirror kotlin_property local_path sha256', f'/artwork/{i}')
        require(type(a['fill']) is int and type(a['autoMirror']) is bool, 'fill/mirror types', pointer=f'/artwork/{i}')
        require(re.fullmatch('[a-z][a-z0-9_]*\\.fill[01]', a['id']) and a['id'] == f"{a['name']}.fill{a['fill']}"
                and re.fullmatch('[A-Z][A-Za-z0-9]*Fill[01]', a['kotlin_property']), 'invalid artwork identifier', 'E_ID', f'/artwork/{i}')
    expected = [{k: a[k] for k in ['id', 'name', 'fill', 'autoMirror', 'kotlin_property', 'local_path', 'sha256']}
                for a in idx['assets']]
    require(m['artwork'] == expected, 'artwork identity/axes/fill/mirroring differs from selection', 'E_ID', '/artwork')
    require(len({a['name'] for a in m['artwork']}) == COUNTS['material_names'], 'Material name inventory mismatch', pointer='/artwork')

    ids, properties, paths = set(), set(), set()
    metadata = strict_json(safe(vendor, 'metadata/selected-rows.json').read_bytes())
    for i, a in enumerate(idx['assets']):
        require(type(a['fill']) is int and type(a['autoMirror']) is bool, 'fill/mirror types', asset=a['id'])
        require(a['id'] not in ids and a['kotlin_property'] not in properties, 'colliding ID', 'E_ID', asset=a['id'])
        ids.add(a['id'])
        properties.add(a['kotlin_property'])
        paths.add(a['local_path'])
        require(a['source_revision'] == PIN and (a['family'], a['weight'], a['grade'], a['optical_size'])
                == ('Material Symbols Rounded', 400, 0, 24), 'wrong family/axes', 'E_PROVENANCE', asset=a['id'])
        require(a['autoMirror'] == (a['id'] in MIRRORED), 'unexpected mirroring', 'E_ID', asset=a['id'])
        raw = safe(vendor, a['local_path']).read_bytes()
        require(len(raw) == a['bytes'] and digest(raw) == a['sha256'], 'SVG bytes/hash mismatch', 'E_HASH', asset=a['id'])
        require(a['provenance_pointer'] == f'/assets/{i}' and digest(canonical(prov['assets'][i])) == a['provenance_record_sha256'],
                'provenance pointer/hash mismatch', 'E_PROVENANCE', asset=a['id'])
        eligible = []
        for row in metadata['names'][a['name']]:
            raw_row = row['row']
            ok = 'Material Symbols Rounded' not in raw_row['unsupported_families'] and 24 in raw_row['sizes_px']
            require(ok == row['rounded_24_eligible'] and digest(canonical(raw_row)) == row['canonical_json_sha256'],
                    'row eligibility/hash changed', 'E_PROVENANCE', asset=a['id'])
            if ok:
                eligible.append(row['json_pointer'])
        require(eligible == a['eligible_metadata_row_pointers'] and eligible, 'ineligible row identity', 'E_PROVENANCE', asset=a['id'])
    require(paths == {n for n in actual if n.endswith('.svg')}, 'unused SVG', 'E_INPUT')

    require(type(m['decisions']) is dict and sorted(m['decisions']) == [f'D{n:02d}' for n in range(1, 11)],
            'accepted decision inventory D01-D10 required', pointer='/decisions')
    for key, summary in m['decisions'].items():
        text(summary, '/decisions/' + key)
    policy = m['accessibility']
    keys(policy, POLICY_KEYS, '/accessibility')
    require(policy['android_child_contentDescription'] is None and policy['ios_child_accessibility_hidden'] is True
            and policy['no_raw_key_spoken'] is True, 'artwork cannot own accessibility', pointer='/accessibility')
    for key in POLICY_KEYS.split():
        if type(policy[key]) is str:
            text(policy[key], '/accessibility/' + key)
    keys(m['history'], 'historical_exact_matches fresh_pins_without_historical_digest metadata', '/history')
    require(m['history']['historical_exact_matches'] == 5 and m['history']['fresh_pins_without_historical_digest'] == 49,
            'false historical provenance', pointer='/history')

    forbidden = ids | properties | set(m['sf_literals']) | {a['name'] for a in m['artwork']}
    validate_concepts(m, idx, ids, forbidden)
    symbol_union = {s['name'] for c in m['concepts'] for s in c['sf_symbols']}
    require(symbol_union == set(m['sf_literals']), 'SF literal not owned by a concept', pointer='/sf_literals')
    return m, digest(manifest_bytes)


# ---------------------------------------------------------------- generation

def kotlin_string(value):
    if value is None:
        return 'null'
    require(type(value) is str and not any(ord(c) < 32 for c in value), 'unsafe Kotlin literal')
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"').replace('$', '\\$') + '"'


def swift_string(value):
    if value is None:
        return 'nil'
    require(type(value) is str and not any(ord(c) < 32 for c in value), 'unsafe Swift literal')
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'


def sf_property(name):
    words = name.split('.')
    return words[0] + ''.join(w[:1].upper() + w[1:] for w in words[1:])


def vector_source(prop, ops, mirror, asset, input_sha=None):
    maximum = Fraction(0)
    lines = []
    for op in ops:
        args = []
        for v in op[1:]:
            literal, error = float_literal(v, asset)
            maximum = max(maximum, error)
            args.append(literal)
        lines.append('                ' + {'M': 'moveTo', 'L': 'lineTo', 'Q': 'quadTo', 'Z': 'close'}[op[0]]
                     + '(' + ', '.join(args) + ')')
    source = f'    // {asset}; input SHA256 {input_sha}.\n' if input_sha else ''
    source += f'''    private val {prop}Cache = lazy(LazyThreadSafetyMode.SYNCHRONIZED) {{
        ImageVector.Builder(name = {kotlin_string(asset)}, defaultWidth = 24.dp, defaultHeight = 24.dp,
            viewportWidth = 960f, viewportHeight = 960f, autoMirror = {str(mirror).lower()}).apply {{
            path(fill = SolidColor(Color.Black), pathFillType = PathFillType.NonZero) {{
{chr(10).join(lines)}
            }}
        }}.build()
    }}
    internal val {prop}: ImageVector get() = {prop}Cache.value
'''
    return source, maximum


IMPORTS = '''package conclave.module

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.dp
'''


def generate(root):
    m, manifest_sha = validate(root)
    generator_sha = digest(Path(__file__).read_bytes())
    header = (f'// GENERATED by {GENERATOR}; do not edit.\n'
              f'// Profile {PROFILE}; manifest SHA256 {manifest_sha}; generator SHA256 {generator_sha}.\n')
    attribution = ('// Material Symbols by Google. Conclave converted the original SVGs (strict SVG parsing,\n'
                   '// exact-decimal translation by (0,+960)) to absolute native path operations.\n'
                   f'// Source commit {PIN}; per-input SHA256 above each vector and in the build-time manifest.\n'
                   '// Apache-2.0, complete text: packages/ui-tokens/icons/vendor/material-symbols/upstream/LICENSE\n'
                   '// (packaged as MaterialSymbols-LICENSE.txt).\n')
    report = {'profile': PROFILE, 'manifest_sha256': manifest_sha, 'generator_sha256': generator_sha,
              'arithmetic': 'exact rational decimals; finite binary32 round-to-nearest-even; nine-digit roundtrip literals',
              'counts': COUNTS, 'assets': []}
    vectors = [header + attribution + IMPORTS + '\ninternal object ConclaveIcons {\n']
    for a in m['artwork']:
        ops = normalize(svg_path(safe(root, VENDOR / a['local_path']).read_bytes(), a['id']), a['id'])
        body, error = vector_source(a['kotlin_property'], ops, a['autoMirror'], a['id'], a['sha256'])
        vectors.append(body)
        kinds = {k: sum(1 for op in ops if op[0] == k) for k in 'MLQZ'}
        report['assets'].append({'id': a['id'], 'input_sha256': a['sha256'], 'segments': len(ops), 'operations': kinds,
                                 'maximum_float32_error': str(error),
                                 'maximum_float32_error_decimal': format(float(error), '.12g')})
    vectors.append('    // Metadata probe; reading isInitialized never evaluates a lazy initializer.\n'
                   '    internal fun initializedCount(): Int = listOf(\n'
                   + ',\n'.join('        ' + a['kotlin_property'] + 'Cache.isInitialized()' for a in m['artwork'])
                   + '\n    ).count { it }\n}\n')
    vector_bytes = ''.join(vectors).encode()

    by_id = {a['id']: a for a in m['artwork']}
    catalog = [header, 'package conclave.module\n\n',
               '// Fixture-only metadata. Closures do not instantiate vectors; there is no runtime name resolver.\n',
               'internal object NativeIconCatalog {\n',
               f'    const val vectorSourceSHA256 = "{digest(vector_bytes)}"\n',
               f'    const val manifestSHA256 = "{manifest_sha}"\n',
               f'    const val generatorSHA256 = "{generator_sha}"\n',
               '    val artwork: List<NativeIconArtwork> = listOf(\n']
    catalog.append(',\n'.join(
        f'        NativeIconArtwork({kotlin_string(a["id"])}, {kotlin_string(a["kotlin_property"])}, '
        f'{kotlin_string(a["sha256"])}, {str(a["autoMirror"]).lower()}) {{ ConclaveIcons.{a["kotlin_property"]} }}'
        for a in m['artwork']) + ',\n    )\n')
    catalog.append('    val bindings: List<NativeIconBinding> = listOf(\n')
    for c in m['concepts']:
        for b in c['bindings']:
            acc = b['accessibility']
            caption = c['concept'] + ': ' + b['state'].replace('_', ' ')
            catalog.append(
                f'        NativeIconBinding({kotlin_string(c["id"] + "." + b["state"])}, {kotlin_string(caption)}, '
                f'{kotlin_string(acc["role"])}, {kotlin_string(acc["label"])}, {kotlin_string(acc["value"])}, '
                f'{kotlin_string(b["fill_basis"])}, {kotlin_string(b["decision_id"])}) '
                f'{{ ConclaveIcons.{by_id[b["artwork"]]["kotlin_property"]} }},\n')
    catalog.append('    )\n}\n')

    swift = [header, '// SF Symbols are system-provided Apple artwork; no Google art is bundled here.\n',
             '#if os(iOS) && !SKIP\n', '/// Exact selected literals. No runtime cases, resolver or automatic `.fill` suffix.\n',
             'enum ConclaveSymbols {\n']
    names = [sf_property(s) for s in m['sf_literals']]
    require(len(set(names)) == len(names) and all(re.fullmatch('[a-z][A-Za-z0-9]*', n) for n in names),
            'colliding SF identifier', 'E_ID', '/sf_literals')
    swift += [f'    static let {n}: String = {swift_string(s)}\n' for n, s in zip(names, m['sf_literals'])]
    swift.append('}\n#endif\n')

    symbols = [header, '#if DEBUG && os(iOS) && !SKIP\n',
               '// Metadata only. SwiftUI Image construction stays in visible lazy rows.\n',
               'enum NativeSymbolCatalog {\n', '    static let rows: [NativeSymbolSpecimen] = [\n']
    for c in m['concepts']:
        for s in c['sf_symbols']:
            symbols.append(f'        NativeSymbolSpecimen(id: {swift_string(c["id"] + "." + s["name"])}, '
                           f'caption: {swift_string(c["concept"])}, detail: {swift_string(s["name"] + ": " + s["context"])}, '
                           f'symbol: ConclaveSymbols.{sf_property(s["name"])}),\n')
        for system in c['ios_system']:
            symbols.append(f'        NativeSymbolSpecimen(id: {swift_string(c["id"] + "." + system["kind"])}, '
                           f'caption: {swift_string(c["concept"])}, detail: {swift_string("System-owned: " + system["policy"])}, '
                           f'symbol: nil),\n')
    symbols.append('    ]\n}\n#endif\n')

    fixture_data = strict_json(safe(root, ICON / 'semantic-fixtures.json').read_bytes())
    keys(fixture_data, 'fixtures', '/fixtures')
    require(type(fixture_data['fixtures']) is list and len(fixture_data['fixtures']) == 4, 'four semantic fixtures required')
    fixtures = [header, IMPORTS, '\n// Converter outputs for the four hand-derived geometry fixtures; compared with\n',
                '// NativeIconGeometryFixtures, which is authored independently of this generator.\n',
                'internal object NativeConvertedIconFixtures {\n']
    for i, f in enumerate(fixture_data['fixtures']):
        keys(f, 'id property path', f'/fixtures/{i}')
        require(re.fullmatch('[a-z][a-z_]*', f['id']) and re.fullmatch('[A-Z][A-Za-z]*', f['property']),
                'invalid fixture identifier', 'E_ID', f'/fixtures/{i}')
        body, _ = vector_source(f['property'], normalize(f['path'], f['id']), False, f['id'])
        fixtures.append(body)
    fixtures.append('}\n')

    full_license = safe(root, VENDOR / 'upstream/LICENSE').read_bytes()
    outputs = {
        ANDROID / 'ConclaveIcons.kt': vector_bytes,
        ANDROID / 'NativeIconCatalog.kt': ''.join(catalog).encode(),
        ANDROID / 'NativeConvertedIconFixtures.kt': ''.join(fixtures).encode(),
        IOS / 'ConclaveSymbols.swift': ''.join(swift).encode(),
        IOS / 'NativeSymbolCatalog.swift': ''.join(symbols).encode(),
        REPORT: (json.dumps(report, indent=2, sort_keys=True) + '\n').encode(),
        IOS_LICENSE: full_license,
        ANDROID_LICENSE: full_license,
    }
    for rel, data in outputs.items():
        if rel not in (IOS_LICENSE, ANDROID_LICENSE):
            decoded = data.decode('utf-8')
            require('\r' not in decoded and not any(d in decoded for d in DASHES) and decoded.endswith('\n'),
                    'nondeterministic or dash-bearing generated text', 'E_OUTPUT_DRIFT', asset=str(rel))
    return outputs


def publish(root, outputs, check=False):
    extras = []
    for folder in [ANDROID, IOS]:
        path = safe(root, folder)
        if path.exists():
            extras += [str(p.relative_to(root)) for p in path.rglob('*')
                       if (p.is_file() or p.is_symlink()) and p.name not in IGNORED_NAMES
                       and p.relative_to(root) not in outputs]
    require(not extras, 'extra generated outputs: ' + str(extras), 'E_OUTPUT_DRIFT')
    changed = []
    for rel, data in outputs.items():
        path = safe(root, rel)
        if not path.is_file() or path.read_bytes() != data:
            changed.append(str(rel))
    if check:
        require(not changed, 'missing/stale generated outputs: ' + str(changed), 'E_OUTPUT_DRIFT')
        return changed
    # Everything was validated and rendered before this point. Stage all bytes first, then
    # replace; an I/O failure restores completed replacements so prior output survives.
    with tempfile.TemporaryDirectory(prefix='.icons-stage-', dir=safe(root, ICON)) as staging:
        stage = Path(staging)
        previous, replaced = {}, []
        for n, data in enumerate(outputs.values()):
            (stage / str(n)).write_bytes(data)
        try:
            for n, rel in enumerate(outputs):
                path = safe(root, rel)
                previous[rel] = path.read_bytes() if path.exists() else None
                path.parent.mkdir(parents=True, exist_ok=True)
                os.replace(stage / str(n), path)
                replaced.append(rel)
        except BaseException:
            for rel in reversed(replaced):
                if previous[rel] is None:
                    safe(root, rel).unlink()
                else:
                    safe(root, rel).write_bytes(previous[rel])
            raise
    return changed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='read-only drift check; never writes')
    args = parser.parse_args()
    try:
        outputs = generate(ROOT)
        changed = publish(ROOT, outputs, args.check)
        print(json.dumps({'status': 'checked' if args.check else 'generated', 'outputs': len(outputs),
                          'changed': len(changed), 'profile': PROFILE, **COUNTS}, sort_keys=True))
    except (IconError, OSError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
