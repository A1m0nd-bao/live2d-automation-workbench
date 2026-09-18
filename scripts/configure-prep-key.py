"""Interactive Mac-only secret entry. Never writes keys into source or browser."""
import getpass
import subprocess
import sys
import argparse
import re

PROVIDERS = {
    'image2': ('Vercel AI Gateway', 'Gateway API Key', 'morph-live2d-ai-gateway-api-key'),
    'doubao': ('豆包 · 火山方舟', '火山方舟 API Key', 'morph-live2d-volcengine-ark-api-key'),
}


def normalize_key(raw):
    """Accept a bare key or a single key-related env assignment; never execute it.

    Preserve the entire RHS: an embedded UUID is not necessarily the full key.
    Do not mistake base64 padding for an assignment.
    """
    value = raw.strip()
    match = re.fullmatch(r'(?:export\s+)?([A-Za-z_][A-Za-z0-9_]{0,63})\s*=\s*(.+)', value)
    if match and re.search(r'key|token|secret', match.group(1), re.I) and match.group(2).strip('= '):
        value = match.group(2).strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'", '`'):
        value = value[1:-1].strip()
    if (len(value) < 16 or not value.isascii() or any(c.isspace() for c in value)
            or value.startswith(('http://', 'https://')) or any(c in value for c in (';', '`', '"', "'", '$', '\\'))):
        raise ValueError('内容不是单个 API Key，未保存；请仅复制密钥值或一行 API Key 配置。')
    return value


def main():
    parser = argparse.ArgumentParser(description='安全配置生图服务凭据')
    parser.add_argument('--provider', choices=PROVIDERS, default='image2')
    args = parser.parse_args()
    if sys.platform != 'darwin' or not sys.stdin.isatty():
        raise SystemExit('请在 Mac 终端中运行此配置程序。')
    label, key_label, service = PROVIDERS[args.provider]
    print(f'配置 {label}：Key 只保存到本机钥匙串，不会显示或写入项目。')
    print('只更新所选服务，不会改动另一个生图服务的配置。')
    try:
        value = normalize_key(getpass.getpass(f'粘贴{key_label}（输入不显示），然后回车：'))
    except ValueError as error:
        raise SystemExit(str(error))
    result = subprocess.run(['/usr/bin/security', 'add-generic-password', '-U',
        '-a', getpass.getuser(), '-s', service, '-w', value],
        capture_output=True)
    if result.returncode:
        raise SystemExit('钥匙串保存失败，请检查系统授权。未输出密钥。')
    print('已安全保存。常驻服务会自动读取，无需重启；回网页点“接入本机桥接”，然后检查生图状态。')
    print('保存成功只代表配置完成，不代表余额、模型权限或真实出图已经验证。')


if __name__ == '__main__':
    main()
