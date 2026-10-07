#!/usr/bin/env python3
"""Fail-closed routing and observation checks, not a replacement for host isolation.

Accept only metadata and minimal visible identity observations. Never accept tab
contents, credentials, cookie stores, email bodies, or token-bearing URLs.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sys
import tempfile

POLICY = Path(__file__).resolve().parents[1] / 'job-policy.json'
STATE = Path('/private/tmp') / f'job-browser-gate-{os.getuid()}'
LOCK = Path('/private/tmp/job-application-batch-20261003/browser.lock/owner.json')


class Blocked(ValueError):
    pass


def require(condition, code):
    if not condition:
        raise Blocked(code)


def read(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        raise Blocked('STATE_UNAVAILABLE') from None


def publish(path, value):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    require(path.parent.is_dir() and not path.parent.is_symlink(), 'UNSAFE_STATE_DIRECTORY')
    require(path.parent.stat().st_uid == os.getuid(), 'STATE_OWNER_MISMATCH')
    require(path.parent.stat().st_mode & 0o077 == 0, 'UNSAFE_STATE_PERMISSIONS')
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        json.dump(value, stream)
    temporary.replace(path)


def identity(policy, observation):
    require(observation.get('chromeAccount') == policy['account'], 'CHROME_ACCOUNT_MISMATCH')
    require(observation.get('window') == policy['window'], 'WINDOW_MISMATCH')


def select(policy, enrollment, inventory):
    require(isinstance(inventory, list), 'INVALID_INVENTORY')
    matches = [b for b in inventory if isinstance(b, dict)
               and b.get('metadata', {}).get('extensionInstanceId') == enrollment.get('extensionInstanceId')]
    require(len(matches) == 1, 'PERSONAL_CONNECTOR_UNAVAILABLE_OR_AMBIGUOUS')
    browser = matches[0]
    require(browser.get('family') == policy['browserFamily']
            and browser.get('type') == policy['browserType'], 'NOT_CHROME_EXTENSION')
    require(browser.get('profileName') == enrollment['profileName'], 'CONNECTOR_PROFILE_CHANGED')
    require(browser.get('profileName', '').casefold() not in
            [p.casefold() for p in policy['deniedProfiles']], 'DENIED_PROFILE')
    require(bool(browser.get('id')), 'BROWSER_ID_MISSING')
    return {'browserId': browser['id'], 'extensionInstanceId': enrollment['extensionInstanceId']}


def validate(policy, enrollment, proof, context, lock, paused, now):
    require(not paused, 'MANUAL_TAKEOVER_ACTIVE')
    require(lock.get('owner') == context.get('owner') and bool(context.get('owner')), 'LOCK_OWNER_MISMATCH')
    require(lock.get('acquisition_id') == context.get('acquisitionId')
            and bool(context.get('acquisitionId')), 'LOCK_GENERATION_MISMATCH')
    for field in ('sessionId', 'tabId', 'portalHost', 'owner', 'acquisitionId'):
        require(bool(context.get(field)) and proof.get(field) == context[field], 'PROOF_CONTEXT_CHANGED')
    require(isinstance(context['portalHost'], str) and
            re.fullmatch(r'[a-z0-9]+(?:[.-][a-z0-9]+)*', context['portalHost']) is not None,
            'PORTAL_HOSTNAME_REQUIRED')
    require(proof.get('extensionInstanceId') == enrollment['extensionInstanceId'], 'PROOF_CONNECTOR_CHANGED')
    identity(policy, proof)
    require(proof.get('portalAccount') == policy['account'], 'PORTAL_ACCOUNT_MISMATCH')
    age = now - proof.get('observedAt', 0)
    require(0 <= age <= policy['evidenceMaxAgeSeconds'], 'IDENTITY_EVIDENCE_EXPIRED')
    return {'status': 'verified', 'browserPurpose': 'job-applications', 'tabId': context['tabId']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['doctor', 'enroll', 'route', 'attest', 'check', 'invalidate', 'pause', 'resume'])
    args = parser.parse_args()
    policy = read(POLICY)
    enrollment_path, proof_path = STATE / 'connector.json', STATE / 'identity.json'
    pause_path = STATE / 'manual-takeover.json'
    now = datetime.now(timezone.utc).timestamp()
    if args.command == 'doctor':
        return {'purpose': 'job-applications', 'connector': 'enrolled' if enrollment_path.exists() else 'not-enrolled',
                'externalExecution': 'enabled' if policy.get('externalExecutionEnabled') is True else 'blocked-zen-connector-unavailable',
                'identity': 'requires-fresh-live-check', 'manualTakeover': pause_path.exists(),
                'axi': 'disabled-zen-only',
                'pdf': 'existing-file-local-validation-only; chrome-renderer-disabled',
                'hostIsolation': 'not-enforced-by-this-helper'}
    if args.command in ('invalidate', 'pause', 'resume'):
        proof_path.unlink(missing_ok=True)
        if args.command == 'pause':
            publish(pause_path, {'pausedAt': now})
        elif args.command == 'resume':
            pause_path.unlink(missing_ok=True)
        return {'status': args.command, 'identity': 'invalidated'}
    require(policy.get('externalExecutionEnabled') is True, 'ZEN_CONNECTOR_NOT_IMPLEMENTED')
    data = json.load(sys.stdin)
    if args.command == 'enroll':
        proof_path.unlink(missing_ok=True)
        identity(policy, data)
        require(data.get('family') == 'chrome' and data.get('type') == 'extension', 'NOT_CHROME_EXTENSION')
        require(bool(data.get('extensionInstanceId')) and bool(data.get('profileName')), 'CONNECTOR_IDENTITY_MISSING')
        require(data['profileName'].casefold() not in [p.casefold() for p in policy['deniedProfiles']], 'DENIED_PROFILE')
        publish(enrollment_path, {key: data[key] for key in ('extensionInstanceId', 'profileName')})
        proof_path.unlink(missing_ok=True)
        return {'status': 'enrolled', 'account': policy['account']}
    require(enrollment_path.exists(), 'PERSONAL_CONNECTOR_NOT_ENROLLED')
    enrollment = read(enrollment_path)
    if args.command == 'route':
        try:
            return select(policy, enrollment, data)
        except Blocked:
            proof_path.unlink(missing_ok=True)
            raise
    if args.command == 'attest':
        proof_path.unlink(missing_ok=True)
        proof = {key: data.get(key) for key in ('chromeAccount', 'window', 'portalAccount',
                 'sessionId', 'tabId', 'portalHost', 'owner', 'acquisitionId')}
        proof.update(extensionInstanceId=enrollment['extensionInstanceId'], observedAt=now)
        result = validate(policy, enrollment, proof, data, read(LOCK), pause_path.exists(), now)
        publish(proof_path, proof)
        return result
    try:
        require(proof_path.exists(), 'IDENTITY_EVIDENCE_REQUIRED')
        return validate(policy, enrollment, read(proof_path), data, read(LOCK), pause_path.exists(), now)
    except Blocked:
        proof_path.unlink(missing_ok=True)
        raise


if __name__ == '__main__':
    try:
        print(json.dumps(main()))
    except (Blocked, ValueError, TypeError, KeyError, OSError) as error:
        try:
            (STATE / 'identity.json').unlink(missing_ok=True)
        except OSError:
            pass
        # Error payloads never echo untrusted observations or secrets.
        print(json.dumps({'status': 'blocked', 'reason': str(error) if isinstance(error, Blocked) else 'INVALID_INPUT_OR_STATE'}))
        sys.exit(3)
