"""Interactive Mac-only secret entry. Never writes keys into source or browser."""
import getpass
import subprocess
import sys


def main():
    if sys.platform != 'darwin' or not sys.stdin.isatty():
        raise SystemExit('请在 Mac 终端中运行此配置程序。')
    print('配置 Vercel AI Gateway：Key 只保存到本机钥匙串，不会显示或写入项目。')
    value = getpass.getpass('粘贴 Gateway API Key（输入不显示），然后回车：').strip()
    if len(value) < 16 or any(c.isspace() for c in value):
        raise SystemExit('Key 为空或格式不正确，未保存。')
    result = subprocess.run(['/usr/bin/security', 'add-generic-password', '-U',
        '-a', getpass.getuser(), '-s', 'morph-live2d-ai-gateway-api-key', '-w', value],
        capture_output=True)
    if result.returncode:
        raise SystemExit('钥匙串保存失败，请检查系统授权。未输出密钥。')
    print('已安全保存。常驻服务会自动读取，无需重启；回网页点“接入本机桥接”，然后检查生图状态。')
    print('保存成功只代表配置完成，不代表余额、模型权限或真实出图已经验证。')


if __name__ == '__main__':
    main()
