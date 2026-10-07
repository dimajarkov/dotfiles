import copy
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('gate', Path(__file__).with_name('job-browser-gate.py'))
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)
POLICY = gate.read(gate.POLICY)


class GateTest(unittest.TestCase):
    def setUp(self):
        self.enrollment = {'extensionInstanceId': 'personal-instance', 'profileName': 'Dmitri'}
        self.browser = {'id': 'personal-browser', 'family': 'chrome', 'type': 'extension',
                        'profileName': 'Dmitri', 'metadata': {'extensionInstanceId': 'personal-instance'}}
        self.context = {'sessionId': 'session', 'tabId': 'task-tab', 'portalHost': 'www.seek.com.au',
                        'owner': 'job-284', 'acquisitionId': 'lock-generation'}
        self.lock = {'owner': 'job-284', 'acquisition_id': 'lock-generation'}
        self.proof = dict(self.context, chromeAccount=POLICY['account'], portalAccount=POLICY['account'],
                          window='write', extensionInstanceId='personal-instance', observedAt=1000)

    def validate(self, **changes):
        parameters = dict(policy=POLICY, enrollment=self.enrollment, proof=self.proof,
                          context=self.context, lock=self.lock, paused=False, now=1001)
        parameters.update(changes)
        return gate.validate(**parameters)

    def test_personal_route_does_not_return_support_metadata(self):
        support = dict(self.browser, id='support-browser', profileName='support',
                       metadata={'extensionInstanceId': 'support-instance'})
        result = gate.select(POLICY, self.enrollment, [support, self.browser])
        self.assertEqual(result['browserId'], 'personal-browser')
        self.assertNotIn('support', json.dumps(result))

    def test_missing_duplicate_or_changed_connector_is_blocked(self):
        inventories = [[], [self.browser, self.browser],
                       [dict(self.browser, family='arc')], [dict(self.browser, type='cdp')],
                       [dict(self.browser, profileName='support')], [dict(self.browser, id=None)]]
        for inventory in inventories:
            with self.subTest(inventory=inventory), self.assertRaises(gate.Blocked):
                gate.select(POLICY, self.enrollment, inventory)

    def test_valid_fresh_identity(self):
        self.assertEqual(self.validate()['status'], 'verified')

    def test_every_identity_and_context_mismatch_is_blocked(self):
        for field in self.proof:
            proof = copy.deepcopy(self.proof)
            proof[field] = 0 if field == 'observedAt' else 'wrong'
            with self.subTest(field=field), self.assertRaises(gate.Blocked):
                self.validate(proof=proof)

    def test_takeover_stale_future_and_lock_replacement_are_blocked(self):
        for changes in [dict(paused=True), dict(now=1061), dict(now=999),
                        dict(lock={}), dict(lock={'owner': 'job-285', 'acquisition_id': 'lock-generation'}),
                        dict(lock={'owner': 'job-284', 'acquisition_id': 'replacement'})]:
            with self.subTest(changes=changes), self.assertRaises(gate.Blocked):
                self.validate(**changes)

    def test_token_bearing_url_cannot_be_persisted_as_hostname(self):
        context = dict(self.context, portalHost='https://portal.example/?token=secret')
        proof = dict(self.proof, portalHost=context['portalHost'])
        with self.assertRaisesRegex(gate.Blocked, 'PORTAL_HOSTNAME_REQUIRED'):
            self.validate(context=context, proof=proof)

    def test_zen_policy_blocks_legacy_chrome_enrollment_and_routing(self):
        with patch('sys.argv', ['gate', 'enroll']), patch('sys.stdin', io.StringIO('{}')):
            with self.assertRaisesRegex(gate.Blocked, 'ZEN_CONNECTOR_NOT_IMPLEMENTED'):
                gate.main()
        with patch('sys.argv', ['gate', 'doctor']):
            self.assertEqual(gate.main()['externalExecution'], 'blocked-zen-connector-unavailable')

    def test_full_enroll_route_attest_check_pause_resume_flow(self):
        with tempfile.TemporaryDirectory() as temp:
            state, lock = Path(temp) / 'state', Path(temp) / 'lock.json'
            policy_path = Path(temp) / 'legacy-test-policy.json'
            policy_path.write_text(json.dumps(dict(POLICY, externalExecutionEnabled=True)))
            lock.write_text(json.dumps(self.lock))
            def command(name, data=None):
                with patch.object(gate, 'STATE', state), patch.object(gate, 'LOCK', lock), \
                     patch.object(gate, 'POLICY', policy_path), \
                     patch('sys.argv', ['gate', name]), patch('sys.stdin', io.StringIO(json.dumps(data))):
                    return gate.main()
            self.assertEqual(command('doctor')['connector'], 'not-enrolled')
            with self.assertRaises(gate.Blocked):
                command('route', [self.browser])
            observation = dict(self.enrollment, chromeAccount=POLICY['account'], window='write',
                               family='chrome', type='extension')
            self.assertEqual(command('enroll', observation)['status'], 'enrolled')
            self.assertEqual(command('route', [self.browser])['browserId'], 'personal-browser')
            self.assertEqual(command('attest', self.proof)['status'], 'verified')
            self.assertEqual(command('check', self.context)['status'], 'verified')
            with self.assertRaises(gate.Blocked):
                command('attest', dict(self.proof, portalAccount='support@arenacrm.com'))
            with self.assertRaises(gate.Blocked):
                command('check', self.context)
            command('attest', self.proof)
            with self.assertRaises(gate.Blocked):
                command('route', [])
            with self.assertRaises(gate.Blocked):
                command('check', self.context)
            command('attest', self.proof)
            command('pause')
            with self.assertRaises(gate.Blocked):
                command('attest', self.proof)
            command('resume')
            with self.assertRaises(gate.Blocked):
                command('check', self.context)
            command('attest', self.proof)
            lock.write_text(json.dumps(dict(self.lock, acquisition_id='replacement')))
            with self.assertRaises(gate.Blocked):
                command('check', self.context)


if __name__ == '__main__':
    unittest.main()
