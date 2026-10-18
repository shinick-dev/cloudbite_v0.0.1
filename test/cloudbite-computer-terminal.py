"""Desktop terminal wrapper and CloudBite shell checks with stub binaries; POSIX sh only."""
import os
import shutil
import socket
import subprocess
import tempfile
from pathlib import Path

IMAGE = Path(__file__).parent.parent/'images/cloudbite-computer'
WRAPPER, SHELL, RC = IMAGE/'terminal-wrapper.sh', IMAGE/'shell.sh', IMAGE/'shell-rc.sh'
SH = shutil.which('sh')
BASH = shutil.which('bash')
assert SH, 'POSIX sh required'
tmp = Path(tempfile.mkdtemp(prefix='cloudbite-terminal-'))

def script(name, body):
    path = tmp/name
    path.write_text('#!/bin/sh\n' + body, newline='\n'); path.chmod(0o755)
    return str(path)

# The stub "real" terminal records its argv one per line and the environment it inherited.
out = tmp/'argv'
real = script('real-terminal', f'''for a in "$@"; do printf '%s\n' "$a"; done > '{out}'
printf '%s\n' "$GTK_IM_MODULE" "$QT_IM_MODULE" "$XMODIFIERS" "$DISPLAY" "$SHELL" "$PROFILE_LOADED" > '{out}.env'
''')
profile = tmp/'profile.sh'
profile.write_text('PROFILE_LOADED=yes; export PROFILE_LOADED\n', newline='\n')
x11 = tmp/'x11'; x11.mkdir()

def run(*args, display=None, sockets=()):
    env = {k: v for k, v in os.environ.items() if k not in ('DISPLAY', 'PROFILE_LOADED')}
    env.update(CLOUDBITE_TERMINAL_REAL=real, CLOUDBITE_PROFILE=str(profile),
               CLOUDBITE_SHELL='/opt/cloudbite/computer/bin/cloudbite-shell',
               CLOUDBITE_X11_DIR=str(x11))
    if display is not None: env['DISPLAY'] = display
    subprocess.run([SH, str(WRAPPER), *args], env=env, check=True, timeout=20)
    argv = out.read_text().split('\n')[:-1]
    return argv, out.with_suffix('.env').read_text().split('\n')[:-1] if False else \
        Path(str(out) + '.env').read_text().split('\n')[:-1]

DEFAULT = ['--disable-server', '-x', '/opt/cloudbite/computer/bin/cloudbite-shell']
argv, env = run(display=':7')
assert argv == DEFAULT, argv
assert env == ['ibus', 'ibus', '@im=ibus', ':7', '/bin/bash', 'yes'], env

# Options without a command keep their order and spaces; the shell is appended last.
argv, _ = run('--title', 'a b', '--maximize', display=':7')
assert argv == ['--disable-server', '--title', 'a b', '--maximize', '-x',
                '/opt/cloudbite/computer/bin/cloudbite-shell'], argv

# Explicit commands are passed byte-for-byte and never evaluated by the wrapper.
hostile = '$(touch ' + str(tmp/'pwned') + '); `id`; "q" \'s\' * ; |&'
for args in (['-e', hostile], [f'-e{hostile}'], ['--command', hostile], [f'--command={hostile}'],
             ['--title', 'T', '-x', 'bash', '-c', hostile, 'arg two'], ['--execute', 'htop']):
    argv, _ = run(*args, display=':7')
    assert argv == ['--disable-server', *args], (args, argv)
assert not (tmp/'pwned').exists()

# DISPLAY: an existing value wins; an empty one is taken from the first X socket.
if hasattr(socket, 'AF_UNIX'):
    try:
        sock = socket.socket(socket.AF_UNIX); sock.bind(str(x11/'X3'))
    except OSError:
        sock = None
    if sock:
        assert run(display='')[1][3] == ':3'
        assert run(display=':9')[1][3] == ':9'
        sock.close()
assert run(display='')[1][3] in ('', ':3')

# cloudbite-shell: interactive bash with the CloudBite rc file; extra args kept.
argv_file = tmp/'bash-argv'
fake_bash = script('bash', f'for a in "$@"; do printf "%s\n" "$a"; done > \'{argv_file}\'\n')
subprocess.run([SH, str(SHELL), '-c', 'x y'], check=True, timeout=20,
               env={**os.environ, 'CLOUDBITE_BASH': fake_bash, 'CLOUDBITE_SHELL_RC': '/rc'})
assert argv_file.read_text().split('\n')[:-1] == ['--rcfile', '/rc', '-i', '-c', 'x y']

# The rc file keeps the owner's aliases and history settings, then puts the profile last.
if BASH:
    home = tmp/'home'; home.mkdir()
    (home/'.bashrc').write_text('alias ll="ls -l"\nHISTSIZE=4242\nPATH="/old/nvm:$PATH"\n', newline='\n')
    (tmp/'p2.sh').write_text('PATH="/pinned:$PATH"\n', newline='\n')
    res = subprocess.run([BASH, '--rcfile', str(RC), '-i', '-c',
                          'alias ll; echo "$HISTSIZE"; echo "${PATH%%:*}"'],
                         env={**os.environ, 'HOME': str(home), 'CLOUDBITE_PROFILE': str(tmp/'p2.sh')},
                         capture_output=True, text=True, timeout=20)
    lines = res.stdout.split('\n')
    assert "alias ll='ls -l'" in lines and '4242' in lines and '/pinned' in lines, res

shutil.rmtree(tmp, ignore_errors=True)
print('cloudbite-computer-terminal: ok')
