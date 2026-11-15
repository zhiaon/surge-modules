/**
 * Wording for a broken module.
 *
 * The banner used to blame "上游文件已删除" for everything, which is wrong for a
 * repo that vanished or a script hosted outside GitHub. Those differ in what a
 * reader can do about it, so the reason travels from the health check.
 */
export type HealthReason =
  | 'file-removed'
  | 'repo-removed'
  | 'external-host'
  | 'relative-path'
  | 'mixed'
  | null
  | undefined;

export function healthBadge(reason: HealthReason): string {
  switch (reason) {
    case 'repo-removed':
      return '仓库已删除';
    case 'external-host':
      return '外部脚本失效';
    case 'relative-path':
      return '相对路径失效';
    default:
      return '脚本失效';
  }
}

export function healthHint(reason: HealthReason): string {
  switch (reason) {
    case 'file-removed':
      return '该模块引用的脚本已被上游作者删除，安装后不会生效。可以继续使用，但不会有任何效果；建议选择其他同类模块。';
    case 'repo-removed':
      return '该模块引用的脚本所在仓库已不存在，作者已停止维护。安装后不会生效，建议选择其他同类模块。';
    case 'external-host':
      return '该模块的脚本放在 GitHub 以外的自建站，地址已无法访问，且无法核实是否只是换了位置。安装后可能不生效。';
    case 'relative-path':
      return '该模块用相对路径引用脚本，安装后 Surge 无法解析到文件，脚本不会运行。';
    default:
      return '该模块引用的部分脚本已失效，安装后可能只有部分功能生效，建议选择其他同类模块。';
  }
}
