import { findNodeAtLocation, Node, parseTree } from 'jsonc-parser'
import * as vscode from 'vscode'

import { getConfig } from './config'

export interface DependencyGroups {
  startLine: number
  deps: Dependency[]
}

export interface Dependency {
  dependencyName: string
  currentVersion: string
  line: number
}

export const getDependencyFromLine = (fileContents: string, line: number, fileName?: string) => {
  const dependencies = getDependencyInformation(fileContents, fileName)
    .map((d) => d.deps)
    .flat()

  return dependencies.find((d) => d.line === line)
}

export const getDependencyInformation = (
  fileContents: string,
  fileName?: string,
): DependencyGroups[] => {
  if (isPnpmWorkspaceYamlFileName(fileName)) {
    return getYamlDependencyInformation(fileContents)
  }

  return getJsonDependencyInformation(fileContents)
}

const getJsonDependencyInformation = (jsonAsString: string): DependencyGroups[] => {
  const tree = parseTree(jsonAsString)

  if (tree === undefined) {
    return []
  }

  const groups = getConfig().dependencyGroups

  return groups
    .map((group) => findNodeAtLocation(tree, toPath(group)))
    .filter((node): node is Node => node !== undefined)
    .map((node) => toDependencyGroup(jsonAsString, node))
}

function toDependencyGroup(jsonAsString: string, dependencyNode: Node): DependencyGroups {
  if (dependencyNode.type !== 'object' || !dependencyNode.children) {
    return { startLine: 0, deps: [] }
  }

  const deps = dependencyNode.children.flatMap((property) =>
    getDependenciesFromProperty(jsonAsString, property),
  )

  return {
    startLine: offsetToLine(jsonAsString, dependencyNode.offset),
    deps,
  }
}

function getDependenciesFromProperty(jsonAsString: string, property: Node): Dependency[] {
  if (property.type !== 'property' || !property.children || property.children.length < 2) {
    return []
  }

  const keyNode = property.children[0]
  const valueNode = property.children[1]

  if (keyNode.type !== 'string') {
    return []
  }

  if (valueNode.type === 'string') {
    const dependency = toDependency(
      jsonAsString,
      keyNode.value as string,
      valueNode.value as string,
      property.offset,
    )
    return dependency === null ? [] : [dependency]
  }

  // catalogs is an object where each property is itself a dependency object.
  if (valueNode.type === 'object' && valueNode.children) {
    return valueNode.children.flatMap((nestedProperty) =>
      getDependenciesFromProperty(jsonAsString, nestedProperty),
    )
  }

  return []
}

function toDependency(
  jsonAsString: string,
  dependencyName: string,
  version: string,
  offset: number,
): Dependency | null {
  if (version.startsWith('catalog:')) {
    return null
  }

  return {
    dependencyName,
    currentVersion: version,
    line: offsetToLine(jsonAsString, offset),
  }
}

function toPath(group: string): string[] {
  return group
    .split('.')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
}

const getYamlDependencyInformation = (yamlAsString: string): DependencyGroups[] => {
  const groups = getConfig().dependencyGroups.map((group) => ({
    raw: group,
    path: toPath(group),
  }))
  const dependencyGroups = new Map<string, DependencyGroups>()
  const pathStack: Array<{ indent: number; path: string[] }> = []

  yamlAsString.split('\n').forEach((line, index) => {
    const match = /^(\s*)(?:"([^"]+)"|'([^']+)'|([^:#][^:]*?)):\s*(.*?)\s*$/.exec(line)
    if (match === null) {
      return
    }

    const indent = match[1].length
    const key = (match[2] ?? match[3] ?? match[4] ?? '').trim()
    const rawValue = match[5] ?? ''

    while (pathStack.length > 0 && pathStack[pathStack.length - 1].indent >= indent) {
      pathStack.pop()
    }

    const currentPath = [...pathStack.flatMap((entry) => entry.path), key]

    groups.forEach((group) => {
      if (pathsEqual(currentPath, group.path) && !dependencyGroups.has(group.raw)) {
        dependencyGroups.set(group.raw, {
          startLine: index,
          deps: [],
        })
      }
    })

    if (rawValue === '') {
      pathStack.push({ indent, path: [key] })
      return
    }

    const parentPath = currentPath.slice(0, -1)
    const version = parseYamlScalarValue(rawValue)
    if (version === undefined || version.startsWith('catalog:')) {
      return
    }

    groups.forEach((group) => {
      if (!startsWithPath(parentPath, group.path)) {
        return
      }

      if (parentPath.length > group.path.length + 1) {
        return
      }

      const dependencyGroup = dependencyGroups.get(group.raw)
      if (dependencyGroup === undefined) {
        return
      }

      dependencyGroup.deps.push({
        dependencyName: key,
        currentVersion: version,
        line: index,
      })
    })
  })

  return Array.from(dependencyGroups.values())
}

const parseYamlScalarValue = (rawValue: string): string | undefined => {
  const valueWithoutComment = rawValue.replace(/\s+#.*$/, '').trim()
  if (valueWithoutComment === '' || valueWithoutComment === '|' || valueWithoutComment === '>') {
    return undefined
  }

  if (
    (valueWithoutComment.startsWith('"') && valueWithoutComment.endsWith('"')) ||
    (valueWithoutComment.startsWith("'") && valueWithoutComment.endsWith("'"))
  ) {
    return valueWithoutComment.slice(1, -1)
  }

  if (valueWithoutComment.startsWith('{') || valueWithoutComment.startsWith('[')) {
    return undefined
  }

  return valueWithoutComment
}

const startsWithPath = (path: string[], prefix: string[]) => {
  return prefix.every((segment, index) => path[index] === segment)
}

const pathsEqual = (left: string[], right: string[]) => {
  return left.length === right.length && startsWithPath(left, right)
}

// jsonc-parser gives offset in characters, so we have to translate it to line numbers
// this currently does not respect CR-only line breaks... but no one uses that, right? Add it if someone complains.
function offsetToLine(text: string, offset: number): number {
  let line = 0
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') {
      line++
    }
  }
  return line
}

export const isPackageJson = (document: vscode.TextDocument) => {
  // Is checking both slashes necessary? Test on linux and mac.
  return document.fileName.endsWith('\\package.json') || document.fileName.endsWith('/package.json')
}

export const isPnpmWorkspaceYaml = (document: vscode.TextDocument) => {
  return isPnpmWorkspaceYamlFileName(document.fileName)
}

export const isSupportedDependencyFile = (document: vscode.TextDocument) => {
  return isPackageJson(document) || isPnpmWorkspaceYaml(document)
}

const isPnpmWorkspaceYamlFileName = (fileName?: string) => {
  if (fileName === undefined) {
    return false
  }

  return (
    fileName.endsWith('\\pnpm-workspace.yaml') || fileName.endsWith('/pnpm-workspace.yaml')
  )
}
