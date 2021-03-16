import { Rule, SchematicContext, SchematicsException, Tree, chain, noop } from '@angular-devkit/schematics';
import { NodePackageInstallTask } from '@angular-devkit/schematics/tasks'
import { map, concatMap } from 'rxjs/operators'
import { Observable, of, concat } from 'rxjs'

import { handler } from '@wdio/cli/build/commands/config'

import { NodeDependencyType, NodePackage } from './types'
import {
    getAngularVersion,
    removePackageJsonDependency,
    getAngularJsonValue,
    deleteDirectory,
    getLatestNodeVersion,
    addPackageJsonDependency,
    removeE2ELinting,
    addWDIOTsConfig
} from './utils'

// You don't have to export the function as default. You can also have more than one rule factory
// per file.
export function webdriverioSchematics(_options: any): Rule {
    return (tree: Tree, _context: SchematicContext) => {
        _options = { ..._options, __version__: getAngularVersion(tree) };

        return chain([
            updateDependencies(_options),
            _options.removeProtractor ? removeFiles() : noop(),
            runWizard(),
            !_options.noBuilder ? modifyAngularJson(_options) : noop(),
        ])(tree, _context);
    };
}

function updateDependencies(options: any): Rule {
    let removeDependencies: Observable<Tree>;
    return (tree: Tree, context: SchematicContext): Observable<Tree> => {
        context.logger.debug('Updating dependencies...')
        context.addTask(new NodePackageInstallTask())

        if (options.removeProtractor) {
            removeDependencies = of('protractor').pipe(
                map((packageName: string) => {
                    context.logger.debug(`Removing ${packageName} dependency`);

                    removePackageJsonDependency(tree, {
                        type: NodeDependencyType.Dev,
                        name: packageName,
                    });

                    return tree;
                })
            );
        }

        const addDependencies = of('@wdio/cli').pipe(
            concatMap((packageName: string) => getLatestNodeVersion(packageName)),
            map((packageFromRegistry: NodePackage) => {
                const { name, version } = packageFromRegistry;
                context.logger.debug(`Adding ${name}:${version} to ${NodeDependencyType.Dev}`);

                addPackageJsonDependency(tree, {
                    type: NodeDependencyType.Dev,
                    name,
                    version,
                });

                return tree;
            })
        );

        if (options.removeProtractor) {
            return concat(removeDependencies, addDependencies);
        }
        return concat(addDependencies);
    };
}

function removeFiles(): Rule {
    return (tree: Tree, context: SchematicContext) => {
        if (!tree.exists('./angular.json')) {
            return tree
        }

        const angularJsonValue = getAngularJsonValue(tree)
        const { projects } = angularJsonValue

        // clean up projects generated by cli with versions <= 7
        Object.keys(projects)
            .filter((name) => name.endsWith('-e2e'))
            .forEach((projectName) => {
                const projectRoot = projects[projectName].root
                deleteDirectory(tree, projectRoot)
                context.logger.debug(`Removing ${projectName} from angular.json projects`)
                delete angularJsonValue.projects[projectName]
            })

        // clean up projects generated by cli with versions > 7
        Object.keys(projects)
            .filter((name) => !name.endsWith('-e2e'))
            .forEach((projectName) => {
                const projectRoot = projects[projectName].root
                deleteDirectory(tree, `${projectRoot}/e2e`)
            })

        return tree.overwrite(
            './angular.json',
            JSON.stringify(angularJsonValue, null, 2)
        )
    }
}

function runWizard(): Rule {
    return (tree: Tree): Observable<Tree> => {
        return concat(handler({ yes: false, yarn: false }).then(() => tree))
    }
}

function modifyAngularJson(options: any): Rule {
    return (tree: Tree, context: SchematicContext) => {
        if (!tree.exists('./angular.json')) {
            throw new SchematicsException('angular.json not found');
        }

        const angularJsonVal = getAngularJsonValue(tree);
        const { projects } = angularJsonVal;

        if (!projects) {
            throw new SchematicsException('projects in angular.json is not defined');
        }

        Object.keys(projects).forEach((project) => {
            const wdioConf = {
                builder: '@wdio/schematics:wdio',
                options: {
                    devServerTarget: `${project}:serve`,
                },
                configurations: {
                    production: {
                        devServerTarget: `${project}:serve:production`,
                    }
                }
            }

            const configFile = !!projects[project].root
                ? `${projects[project].root}/wdio.conf.js`
                : null

            if (configFile) {
                Object.assign(wdioConf.options, { configFile });
            }

            if (options.removeProtractor) {
                context.logger.debug(`Replacing e2e command with wdio-run in angular.json`);
                removeE2ELinting(tree, angularJsonVal, project);
            }

            context.logger.debug(`Adding webdriverio/tsconfig.json to angular.json-tslint config`);
            addWDIOTsConfig(tree, angularJsonVal, project);

            context.logger.debug(`Adding cypress-run and cypress-open commands in angular.json`);
            const projectArchitectJson = angularJsonVal['projects'][project]['architect'];
            projectArchitectJson['wdio-run'] = wdioConf
            if (options.removeProtractor) {
                projectArchitectJson['e2e'] = wdioConf;
            }

            return tree.overwrite('./angular.json', JSON.stringify(angularJsonVal, null, 2));
        });


      return tree;
    };
}