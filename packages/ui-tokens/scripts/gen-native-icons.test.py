"""Independent expected geometry, archived-semantics replay and fail-closed generator regressions.

No renderer oracle and no converter self-comparison: expected coordinates are hand-derived, the
winding sampler only inspects explicit line segments, and binding semantics are replayed from the
sealed archived construction records rather than from the manifest under test.
"""
import ast
import copy
from fractions import Fraction as F
import importlib.util
import json
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('icons', Path(__file__).with_name('gen-native-icons.py'))
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)
MANIFEST = g.ROOT / g.ICON / 'manifest.json'


# ---------------------------------------------------------------- archived semantics replay

def archived_text(name):
    return json.loads((g.ROOT / g.EVIDENCE / name).read_bytes())['item']['text']


def archived_literal(source, pattern):
    match = re.search(pattern, source, re.S)
    assert match, pattern
    return ast.literal_eval(match.group(1))


def replay_archived_semantics(index_concepts):
    """Replays manifest-activity 0-47 construction plus the 0-59 and 0-83 patches.

    Literal data comes verbatim from the archived scripts; the control flow mirrors their code.
    The F00 label and SF cells come from the accepted selected-input index.
    """
    t47 = archived_text('manifest-activity-0-47.json')
    t59 = archived_text('manifest-activity-0-59.json')
    t83 = archived_text('manifest-activity-0-83.json')
    data = archived_literal(t47, r'\ndata=(\[\n.*?\n\])\n')
    explicit = archived_literal(t47, r'\nexplicit=(\{[^\n]*\})\n')
    choices = archived_literal(t47, r'\nchoices=(\{\n.*?\n\})\n')
    extra_sf = archived_literal(t47, r'\nextra_sf=(\{[^\n]*\})\n')
    decisions = archived_literal(t47, r'for i,s in (\[\n.*?\])\],')
    policy = archived_literal(t47, r"'accessibility_policy':(\{.*?\}),\n")
    contexts = archived_literal(t59, r'\ncontexts=(\{\n.*?\n\})\n')
    for key in ['roles', 'state_only_style']:
        policy[key] = re.search(r"d\['accessibility_policy'\]\['" + key + r"'\]='([^'\n]*)'\n", t59).group(1)
    values = archived_literal(t83, r'\n  values=(\{[^\n]*\})\n')
    assert len(data) == len(index_concepts) == 36
    concepts = []
    for c, (cid, pairs, role, value, _) in zip(index_concepts, data):
        assert c['id'] == cid
        labels = re.findall(r'"([^"]+)"', c['canonical_label_cell'])
        line = c['canonical_line_at_recovery']
        symbols = []
        for name in re.findall(r'`([^`]+)`', c['canonical_sf_cell']):
            if name.startswith('Button(') or name == 'AVRoutePickerView':
                continue
            # 0-59 replaced every canonical context with its reviewed contextual meaning.
            symbols.append({'name': name, 'context': contexts.get(cid, {}).get(
                name, 'canonical ' + cid + ' use; exact literal takes precedence over generic fill convention')})
        for name, context, _, _ in extra_sf.get(cid, []):
            symbols.append({'name': name, 'context': context})
        if cid == 'copy_link':
            symbols.append({'name': 'checkmark', 'context': 'copied_confirmation'})
        bindings = []
        for pair in pairs.split(';'):
            name, fill, state = pair.split(':')
            fill = int(fill)
            basis = 'requirement' if (name, fill) in explicit else (
                'derived_requirement' if name in ['lock', 'lock_open', 'cancel_presentation']
                or (name == 'present_to_all' and fill == 0) else 'recommendation')
            decision = None if (name, fill) in explicit else choices.get(name, ('D01', ''))[0]
            references = ['S10:493', 'S10:952'] if cid == 'copy_link' and name == 'check' else [f'F00:{line}']
            label, arole, avalue = (labels[0] if labels else None), role, value
            if cid == 'pin':
                label = {'pin_action': 'Pin', 'unpin_action': 'Unpin', 'pinned_badge': None}[state]
                arole = 'status' if state == 'pinned_badge' else 'button'
                avalue = 'pinned' if state == 'pinned_badge' else None
            if cid == 'share_screen' and state == 'presenting_badge':
                label, arole, avalue = None, 'status', 'presenting'
            if cid == 'search':
                arole, label = 'decorative', None
            if cid in ['speaking', 'weak_connection', 'warning_error_info']:
                label = None
            bindings.append({'state': state, 'artwork': f'{name}.fill{fill}', 'fill_basis': basis,
                             'decision_id': decision, 'references': references,
                             'accessibility': {'label': label, 'value': avalue, 'role': arole,
                                               'icon_exposure': 'decorative_in_labeled_owner'}})
        # Patch 0-59.
        for b in bindings:
            if cid == 'participants':
                b['accessibility']['value'] = 'participant and waiting counts; open selection semantics recommended with D02'
            if cid == 'host':
                b['state'] = 'host_badge'
                b['accessibility']['label'] = None
        if cid == 'host':
            bindings.append({'state': 'host_controls_action', 'artwork': 'shield_person.fill0', 'fill_basis': 'recommendation',
                             'decision_id': 'D01', 'references': ['S30:696'],
                             'accessibility': {'label': 'Host controls', 'value': None, 'role': 'button',
                                               'icon_exposure': 'decorative_in_labeled_owner'}})
        if cid == 'search':
            bindings.append({'state': 'search_action', 'artwork': 'search.fill0', 'fill_basis': 'recommendation',
                             'decision_id': 'D01', 'references': ['F00:896'],
                             'accessibility': {'label': 'Search', 'value': None, 'role': 'button',
                                               'icon_exposure': 'decorative_in_labeled_owner'}})
        if cid == 'lock_meeting':
            for b in bindings:
                b['accessibility']['role'] = 'checkbox'
                b['references'].append('S50:908')
        # Patch 0-83.
        for b in bindings:
            if (cid, b['state']) in values:
                b['accessibility']['value'] = values[(cid, b['state'])]
        if cid == 'share_screen':
            sharing = next(b for b in bindings if b['state'] == 'sharing_stop_action')
            sharing['state'] = 'sharing_toggle'
            action = copy.deepcopy(sharing)
            action['state'] = 'stop_sharing_action'
            action['accessibility'] = {'label': 'Stop sharing', 'value': None, 'role': 'button',
                                       'icon_exposure': 'decorative_in_labeled_owner'}
            bindings.append(action)
        if cid == 'reactions':
            for b in bindings:
                b['references'].append('S30:762')
        system = []
        if cid == 'audio_output':
            system = [{'kind': 'route_picker', 'policy': 'AVRoutePickerView owns glyph and route semantics; no SF string synthesized.'}]
        if cid == 'back':
            system = [{'kind': 'system_navigation_back', 'policy': 'System back owns its symbol, label and RTL behavior; no SF string synthesized.'}]
        if cid == 'close':
            system = [{'kind': 'system_close', 'policy': 'Button(role: .close) only with iOS 26 runtime guard in native iOS file; older path uses explicitly labeled Close/Done or xmark according to host. Guard/minimum-OS validation remains open.'}]
        concepts.append({'id': cid, 'sf_symbols': symbols, 'ios_system': system, 'bindings': bindings})
    return {'concepts': concepts, 'decisions': dict(decisions), 'accessibility': policy}


def vendored_index():
    return json.loads((g.ROOT / g.VENDOR / 'selected-input-index.json').read_bytes())


class ArchivedSemantics(unittest.TestCase):
    def test_manifest_semantics_replay_sealed_archived_records(self):
        manifest = json.loads(MANIFEST.read_bytes())
        replay = replay_archived_semantics(vendored_index()['concepts'])
        self.assertEqual(manifest['decisions'], replay['decisions'])
        self.assertEqual(manifest['accessibility'], replay['accessibility'])
        # Explicit length check instead of zip(strict=True), which needs Python 3.10 (macOS system python3 is 3.9).
        self.assertEqual(len(manifest['concepts']), len(replay['concepts']))
        for actual, expected in zip(manifest['concepts'], replay['concepts']):
            with self.subTest(concept=expected['id']):
                self.assertEqual({k: actual[k] for k in expected}, expected)
        self.assertEqual(sum(len(c['bindings']) for c in replay['concepts']), 58)

    def test_contract_semantics_spot_checks(self):
        # Fixed expectations from the recovered contract's accessibility section, not from the replay.
        manifest = json.loads(MANIFEST.read_bytes())
        b = {f"{c['id']}.{x['state']}": x for c in manifest['concepts'] for x in c['bindings']}
        acc = {k: (v['accessibility']['label'], v['accessibility']['value'], v['accessibility']['role']) for k, v in b.items()}
        self.assertEqual(acc['microphone.on'], ('Microphone', 'On', 'switch'))
        self.assertEqual(acc['microphone.muted'], ('Microphone', 'Muted', 'switch'))
        self.assertEqual(acc['camera.off'], ('Camera', 'Off', 'switch'))
        self.assertEqual(acc['raise_hand.raised'], ('Raise hand', 'Raised', 'switch'))
        self.assertEqual(acc['raise_hand.lowered'], ('Raise hand', 'Not raised (Android); absent (iOS)', 'switch'))
        self.assertEqual(acc['captions.on'], ('Captions', 'On', 'switch'))
        self.assertEqual((acc['reactions.closed'][1], acc['reactions.open'][1]), ('Closed', 'Open'))
        self.assertEqual(acc['share_screen.sharing_toggle'], ('Share screen', 'Sharing', 'switch'))
        self.assertEqual(acc['share_screen.stop_sharing_action'], ('Stop sharing', None, 'button'))
        self.assertEqual(acc['host.host_badge'][2], 'status')
        self.assertEqual(acc['host.host_controls_action'], ('Host controls', None, 'button'))
        self.assertEqual(acc['search.decorative_field_leading'], (None, None, 'decorative'))
        self.assertEqual(acc['search.search_action'], ('Search', None, 'button'))
        self.assertEqual(acc['lock_meeting.locked'][2], 'checkbox')
        self.assertEqual(acc['audio_output.bluetooth'][::2], ('Audio output', 'button'))
        self.assertEqual(b['admit.action']['artwork'], b['copy_link.copied']['artwork'])
        self.assertEqual([a['id'] for a in manifest['artwork'] if a['autoMirror']], list(g.MIRRORED))
        self.assertIsNone(manifest['accessibility']['android_child_contentDescription'])


# ---------------------------------------------------------------- converter semantics

class PathSemantics(unittest.TestCase):
    def test_initial_relative_and_implicit_repetition(self):
        self.assertEqual(g.normalize('m10 -950 20 0 0 20z'), [('M', 10, 10), ('L', 30, 10), ('L', 30, 30), ('Z',)])
        self.assertEqual(g.normalize('M10 -950 30 -950 30 -930'), [('M', 10, 10), ('L', 30, 10), ('L', 30, 30)])

    def test_quadratic_relative_reflection_repeated(self):
        self.assertEqual(g.normalize('M10 -950q10 0 10 10t10 10 10 -10'),
                         [('M', 10, 10), ('Q', 20, 10, 20, 20), ('Q', 20, 30, 30, 30), ('Q', 40, 30, 40, 20)])
        self.assertEqual(g.normalize('M0 -960Q10 -960 20 -950 30 -940 40 -950T60 -950 80 -950'),
                         [('M', 0, 0), ('Q', 10, 0, 20, 10), ('Q', 30, 20, 40, 10), ('Q', 50, 0, 60, 10), ('Q', 70, 20, 80, 10)])

    def test_reflection_reset_and_close_current_point(self):
        self.assertEqual(g.normalize('M10 -950Q20 -950 20 -940L30 -930T40 -920M50 -910T60 -900Z m10 20t10 0'),
                         [('M', 10, 10), ('Q', 20, 10, 20, 20), ('L', 30, 30), ('Q', 30, 30, 40, 40), ('M', 50, 50),
                          ('Q', 50, 50, 60, 60), ('Z',), ('M', 60, 70), ('Q', 60, 70, 70, 70)])
        self.assertEqual(g.normalize('M10 -950Q20 -950 20 -940ZT30 -930'),
                         [('M', 10, 10), ('Q', 20, 10, 20, 20), ('Z',), ('Q', 10, 10, 30, 30)])
        # H and V reset reflection exactly like L.
        self.assertEqual(g.normalize('M0 -960Q10 -960 10 -950H20T30 -950'),
                         [('M', 0, 0), ('Q', 10, 0, 10, 10), ('L', 20, 10), ('Q', 20, 10, 30, 10)])

    def test_hv_both_cases_and_zero_length(self):
        self.assertEqual(g.normalize('M10 -950h20v20H40V-910l0 0z'),
                         [('M', 10, 10), ('L', 30, 10), ('L', 30, 30), ('L', 40, 30), ('L', 40, 50), ('L', 40, 50), ('Z',)])

    def test_exact_decimal_exponent_and_adjacent_sign_dot(self):
        self.assertEqual(g.normalize('m.1,-9.599e2.2-.1L+3e-1 -960'),
                         [('M', F('0.1'), F('0.1')), ('L', F('0.3'), 0), ('L', F('0.3'), 0)])
        self.assertEqual(g.normalize('M0 -960' + ' l.1 .1' * 100)[-1], ('L', 10, 10))

    def test_malformed_and_resource_limits(self):
        bad = ['', 'L0 0', 'M0', 'M0 0 1', 'M,0 0', 'M0,,0', 'M0 0,', 'M0 0,L1 1', 'M0 0Z1 1', 'M0 0C1 1 2 2 3 3',
               'MNaN 0', 'M0 inf', 'M0 0Q1 2 3', 'M0 0T1', 'M0e 0', 'M1e513 0', 'M' + ('1' * 129) + ' 0',
               'M0 0L', 'M0 0LZ', 'M0 0L Z', 'M0 0 L M1 1', 'M0 0H', 'm', 'M0 0\x0cL1 1', 'M0 0 L,1 1']
        for source in bad:
            with self.subTest(source=source[:35]), self.assertRaises(g.IconError):
                g.normalize(source)
        with self.assertRaises(g.IconError):
            g.normalize('M0 0' + 'L0 0' * 10000)

    def test_float32_exact_tie_and_roundtrip_error(self):
        self.assertEqual(g.float_literal(F(1) + F(1, 2 ** 24), 'tie')[0], '1.0f')
        self.assertEqual(g.float_literal(F(1) + F(1, 2 ** 24) + F(1, 10 ** 80), 'above')[0], '1.00000012f')
        self.assertEqual(g.float_literal(F('-0'), 'zero')[0], '0.0f')
        # Nearest binary32 to 1/10 is 13421773/2**27, so the exact error is 2/(10*2**27).
        self.assertEqual(g.float_literal(F('0.1'), 'tenth'), ('0.100000001f', F(1, 671088640)))
        with self.assertRaises(g.IconError):
            g.float_literal(F('1e100'), 'overflow')


class XMLProfile(unittest.TestCase):
    def svg(self, path='M0 -960Z'):
        return f'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 -960 960 960"><path d="{path}"/></svg>'.encode()

    def test_originals_and_exact_structure(self):
        self.assertEqual(g.svg_path(self.svg()), 'M0 -960Z')
        m, _ = g.validate(g.ROOT)
        for a in m['artwork']:
            self.assertTrue(g.normalize(g.svg_path((g.ROOT / g.VENDOR / a['local_path']).read_bytes(), a['id'])))

    def test_reject_features_and_entity_expansion(self):
        raw = self.svg()
        bad = [raw.replace(b'<svg', b'<?xml version="1.0"?><svg'), raw.replace(b'<path', b'<!-- hi --><path'),
               raw.replace(b'<path', b'<?foo hi?><path'), raw.replace(b'<path', b'<![CDATA[x]]><path'),
               raw.replace(b'<path', b'<g><path').replace(b'</svg>', b'</g></svg>'), raw.replace(b'width="24"', b'width="25"'),
               raw.replace(b'<path', b'<path fill="black"'), raw.replace(b'<path', b'hello<path'),
               raw.replace(b'<path', b'<path d="M0 0"/><path'), raw.replace(b'M0 -960Z', b'M&#48; -960Z'),
               b'<!DOCTYPE svg [<!ENTITY x "value">]>' + raw, raw.replace(b'<svg', b'<svg xmlns:x="urn:x"'),
               raw.replace(b'<path', b'<path transform="translate(0 0)"'), raw.replace(b'"/>', b'"><title>x</title></path>'),
               raw.replace(b'viewBox="0 -960 960 960"', b'viewBox="0 0 960 960"')]
        for data in bad:
            with self.subTest(data=data[:90]), self.assertRaises(g.IconError):
                g.svg_path(data)
        with self.assertRaises(g.IconError):
            g.svg_path(b' ' * 131073)

    def test_only_xml_whitespace_may_separate_elements(self):
        # XML S is space, tab, CR and LF. Other Unicode spaces are character data, although str.isspace() is true.
        raw = self.svg()
        for space in [' ', '\t', '\n', '\r\n', ' \t\r\n ']:
            for data in [raw.replace(b'<path', space.encode() + b'<path'), raw.replace(b'</svg>', space.encode() + b'</svg>')]:
                with self.subTest(space=repr(space)):
                    self.assertEqual(g.svg_path(data), 'M0 -960Z')
        for char in ['\u0085', ' ', ' ', ' ', ' ', ' ', ' ', ' ', '　']:
            self.assertTrue(char.isspace())
            for data in [raw.replace(b'<path', (' ' + char + '\n').encode() + b'<path'),
                         raw.replace(b'</svg>', char.encode() + b'</svg>')]:
                with self.subTest(char=f'U+{ord(char):04X}'):
                    with self.assertRaises(g.IconError) as caught:
                        g.svg_path(data)
                    self.assertEqual(caught.exception.details['code'], 'E_SVG_PROFILE')
                    self.assertEqual(caught.exception.details['reason'], 'text content forbidden')


# These fixed specimens are hand-derived from the recovered mathematical contract.
# The winding sampler inspects the resulting explicit lines; it is not another SVG normalizer.
def line_winding(ops, point):
    x, y = point
    winding, current, start = 0, None, None
    for op in ops:
        if op[0] == 'M':
            current = start = op[1:]
            continue
        if op[0] == 'Q':
            raise AssertionError('polygon sampler receives lines only')
        end = start if op[0] == 'Z' else op[1:]
        a, b = current, end
        cross = (b[0] - a[0]) * (y - a[1]) - (x - a[0]) * (b[1] - a[1])
        if a[1] <= y < b[1] and cross > 0:
            winding += 1
        if b[1] <= y < a[1] and cross < 0:
            winding -= 1
        current = end
    return winding


class IndependentGeometry(unittest.TestCase):
    def fixtures(self):
        return json.loads((g.ROOT / g.ICON / 'semantic-fixtures.json').read_text())['fixtures']

    def test_opposite_and_same_nonzero_winding(self):
        a, b, *_ = self.fixtures()
        for fixture, center in [(a, False), (b, True)]:
            ops = g.normalize(fixture['path'])
            self.assertEqual(bool(line_winding(ops, (480, 480))), center)
            self.assertTrue(line_winding(ops, (220, 480)))
            self.assertFalse(line_winding(ops, (20, 20)))
            points = [op[1:] for op in ops if op[0] != 'Z']
            self.assertEqual((min(p[0] for p in points), min(p[1] for p in points), max(p[0] for p in points),
                              max(p[1] for p in points)), (160, 160, 800, 800))

    def test_relative_after_close_separate_components(self):
        ops = g.normalize(self.fixtures()[2]['path'])
        self.assertEqual(ops, [('M', 160, 160), ('L', 320, 160), ('L', 320, 320), ('L', 160, 320), ('Z',),
                               ('M', 480, 480), ('L', 640, 480), ('L', 640, 640), ('L', 480, 640), ('Z',)])
        for point, inside in [((240, 240), True), ((560, 560), True), ((400, 400), False), ((560, 720), False)]:
            self.assertEqual(bool(line_winding(ops, point)), inside)

    def test_smooth_controls_and_analytic_extremum(self):
        ops = g.normalize(self.fixtures()[3]['path'])
        self.assertEqual(ops, [('M', 160, 480), ('Q', 320, 160, 480, 480), ('Q', 640, 800, 800, 480), ('L', 800, 800),
                               ('L', 160, 800), ('Z',)])
        # Quadratic derivative gives t=(p0-p1)/(p0-2*p1+p2), independent of the parser.
        p0, p1, p2 = F(480), F(160), F(480)
        t = (p0 - p1) / (p0 - 2 * p1 + p2)
        self.assertEqual(t, F(1, 2))
        self.assertEqual((1 - t) ** 2 * p0 + 2 * (1 - t) * t * p1 + t * t * p2, 320)
        self.assertEqual((160 * F(72, 960), 320 * F(72, 960), 800 * F(72, 960)), (12, 24, 60))


# ---------------------------------------------------------------- validation, outputs and drift

def mutated(mutation):
    original = MANIFEST.read_bytes()
    read = Path.read_bytes
    m = json.loads(original)
    mutation(m)

    def fake(path):
        return json.dumps(m, ensure_ascii=False).encode() if path == MANIFEST else read(path)
    return patch.object(Path, 'read_bytes', fake)


def binding(m, key):
    concept, state = key.split('.')
    return next(b for c in m['concepts'] if c['id'] == concept for b in c['bindings'] if b['state'] == state)


class ValidationAndDrift(unittest.TestCase):
    def test_duplicate_keys_nonfinite_and_closed_schema(self):
        for data in ['{"a":1,"a":2}', '{"a":NaN}', '{"a":Infinity}', '{"a":-Infinity}']:
            with self.subTest(data=data), self.assertRaises(g.IconError):
                g.strict_json(data)
        mutations = {
            'extra field': lambda m: m.update(extra=True),
            'old schema': lambda m: m.update(schema_version=1),
            'boolean fill': lambda m: m['artwork'][0].update(fill=False),
            'unexpected mirroring': lambda m: m['artwork'][0].update(autoMirror=True),
            'unknown role': lambda m: binding(m, 'microphone.on')['accessibility'].update(role='image'),
            'unknown artwork': lambda m: binding(m, 'microphone.on').update(artwork='unknown.fill0'),
            'missing vendor input': lambda m: m['vendor_files'].pop(next(iter(m['vendor_files']))),
            'unexplained SF literal': lambda m: m['sf_literals'].append('fake'),
            'status with owner label': lambda m: binding(m, 'host.host_badge')['accessibility'].update(label='Host'),
            'control without label': lambda m: binding(m, 'leave.action')['accessibility'].update(label=None),
            'undeclared fill': lambda m: binding(m, 'participants.open').update(decision_id='D99'),
            'requirement with decision': lambda m: binding(m, 'microphone.on').update(decision_id='D01'),
            'bad reference': lambda m: binding(m, 'send.ready_or_disabled').update(references=['F00:0']),
            'raw glyph label': lambda m: binding(m, 'delete.action')['accessibility'].update(label='delete.fill0'),
            'dash in label': lambda m: binding(m, 'delete.action')['accessibility'].update(label='Delete ' + chr(0x2014) + ' now'),
            'unknown accessibility key': lambda m: binding(m, 'delete.action')['accessibility'].update(hint='x'),
            'unknown system kind': lambda m: next(c for c in m['concepts'] if c['id'] == 'back')['ios_system'][0].update(kind='custom'),
            'missing SF context': lambda m: m['concepts'][0]['sf_symbols'].pop(),
            'evidence set': lambda m: m['semantics_evidence'].update(extra='0' * 64),
            'decision inventory': lambda m: m['decisions'].pop('D10'),
            'artwork owns description': lambda m: m['accessibility'].update(android_child_contentDescription='Mic'),
            'state rename': lambda m: binding(m, 'share_screen.stop_sharing_action').update(state='stop'),
            'false history': lambda m: m['history'].update(historical_exact_matches=6),
        }
        for name, mutation in mutations.items():
            with self.subTest(mutation=name), mutated(mutation), self.assertRaises(g.IconError):
                g.validate(g.ROOT)

    def test_changed_inputs_and_evidence_fail_before_writes(self):
        read = Path.read_bytes
        targets = [g.ROOT / g.VENDOR / 'upstream/LICENSE', g.ROOT / g.EVIDENCE / 'manifest-activity-0-59.json',
                   g.ROOT / g.VENDOR / 'assets/symbols/web/send/materialsymbolsrounded/send_fill1_24px.svg']
        for target in targets:
            def fake(path, target=target):
                data = read(path)
                return data + b' ' if path == target else data
            with self.subTest(target=target.name), patch.object(Path, 'read_bytes', fake), self.assertRaises(g.IconError):
                g.generate(g.ROOT)

    def test_path_escape_and_symlinks(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / 'link').symlink_to('/etc')
            for path in ['../bad', '/etc/passwd', 'link/passwd', '']:
                with self.subTest(path=path), self.assertRaises(g.IconError):
                    g.safe(root, path)

    def test_literal_escaping_and_identifier_injection(self):
        self.assertEqual(g.kotlin_string('a"$\\b'), '"a\\"\\$\\\\b"')
        self.assertEqual(g.swift_string('a"\\(b)'), '"a\\"\\\\(b)"')
        self.assertEqual((g.kotlin_string(None), g.swift_string(None)), ('null', 'nil'))
        for unsafe in ['a\nb', 'tab\there']:
            with self.assertRaises(g.IconError):
                g.kotlin_string(unsafe)
            with self.assertRaises(g.IconError):
                g.swift_string(unsafe)
        fixtures = g.ROOT / g.ICON / 'semantic-fixtures.json'
        read = Path.read_bytes
        injected = json.loads(fixtures.read_bytes())
        injected['fixtures'][0]['property'] = 'Bad = TODO()\n    val X'

        def fake(path):
            return json.dumps(injected).encode() if path == fixtures else read(path)
        with patch.object(Path, 'read_bytes', fake), self.assertRaises(g.IconError):
            g.generate(g.ROOT)

    def test_drift_is_nonwriting_missing_stale_extra(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / g.ICON).mkdir(parents=True)
            outputs = {g.ANDROID / 'ConclaveIcons.kt': b'expected\n'}
            with self.assertRaises(g.IconError):
                g.publish(root, outputs, True)
            self.assertFalse((root / g.ANDROID).exists())
            g.publish(root, outputs)
            g.publish(root, outputs, True)
            path = root / g.ANDROID / 'ConclaveIcons.kt'
            path.write_bytes(b'stale')
            before = path.stat().st_mtime_ns
            with self.assertRaises(g.IconError):
                g.publish(root, outputs, True)
            self.assertEqual(path.read_bytes(), b'stale')
            self.assertEqual(path.stat().st_mtime_ns, before)
            (path.parent / 'Extra.kt').write_bytes(b'extra')
            with self.assertRaises(g.IconError):
                g.publish(root, outputs)
            self.assertEqual(path.read_bytes(), b'stale')
            self.assertEqual(sorted(p.name for p in (root / g.ICON).iterdir()), [])

    def test_checked_in_outputs_match_without_writing(self):
        outputs = g.generate(g.ROOT)
        before = {rel: (g.ROOT / rel).stat().st_mtime_ns for rel in outputs}
        self.assertEqual(g.publish(g.ROOT, outputs, check=True), [])
        self.assertEqual(before, {rel: (g.ROOT / rel).stat().st_mtime_ns for rel in outputs})

    def test_determinism_inventory_license_and_lazy_shape(self):
        a = g.generate(g.ROOT)
        b = g.generate(g.ROOT)
        self.assertEqual(a, b)
        report = json.loads(a[g.REPORT])
        self.assertEqual(len(report['assets']), 54)
        self.assertTrue(all(F(x['maximum_float32_error']) == 0 for x in report['assets']))
        vectors = a[g.ANDROID / 'ConclaveIcons.kt'].decode()
        self.assertEqual(vectors.count('lazy(LazyThreadSafetyMode.SYNCHRONIZED)'), 54)
        self.assertEqual(vectors.count('internal val '), 54)
        self.assertEqual(vectors.count('autoMirror = true'), 2)
        self.assertEqual(len(re.findall(r'// [a-z_]+\.fill[01]; input SHA256 [0-9a-f]{64}\.', vectors)), 54)
        self.assertIn('Material Symbols by Google', vectors)
        self.assertIn('PathFillType.NonZero', vectors)
        self.assertNotIn('EvenOdd', vectors)
        self.assertNotRegex(vectors, r'\bmapOf\b|\barrayOf\b|\binit \{|PathParser|addPathNodes|\bparse\w*\(')
        catalog = a[g.ANDROID / 'NativeIconCatalog.kt'].decode()
        self.assertEqual(catalog.count('NativeIconBinding('), 58)
        self.assertEqual(catalog.count('NativeIconArtwork('), 54)
        symbols = a[g.IOS / 'ConclaveSymbols.swift'].decode()
        self.assertEqual(symbols.count('static let '), 50)
        self.assertIn('#if os(iOS) && !SKIP', symbols)
        self.assertNotRegex(symbols, r'\bcase\b|func |\.fill"\s*\+')
        rows = a[g.IOS / 'NativeSymbolCatalog.swift'].decode()
        self.assertEqual(rows.count('symbol: ConclaveSymbols.'), sum(len(c['sf_literals']) for c in vendored_index()['concepts']))
        self.assertEqual(rows.count('symbol: nil'), 3)
        license_bytes = (g.ROOT / g.VENDOR / 'upstream/LICENSE').read_bytes()
        self.assertEqual(g.digest(license_bytes), g.LICENSE_SHA)
        self.assertEqual(a[g.IOS_LICENSE], license_bytes)
        self.assertEqual(a[g.ANDROID_LICENSE], license_bytes)
        self.assertIn(b'APPENDIX: How to apply the Apache License', license_bytes)
        generated = b''.join(v for k, v in a.items() if k not in (g.IOS_LICENSE, g.ANDROID_LICENSE)).decode()
        for forbidden in ['/Users/', '/tmp/', chr(0x2013), chr(0x2014), '\r']:
            self.assertNotIn(forbidden, generated)


if __name__ == '__main__':
    unittest.main(verbosity=2)
