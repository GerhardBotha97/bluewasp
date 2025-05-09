import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { CommandConfig, StageConfig, ConfigProvider, NiobiumConfig, DockerContainerConfig, VariableManager } from './configProvider';
import { promisify } from 'util';
import { JobOutputService } from './ui/jobOutputService';
import { DockerRunner } from './dockerRunner';
import { IgnoreProvider } from './utils/ignoreUtils';
import { sanitizeContainerName } from './utils/dockerUtils';

const execAsync = promisify(cp.exec);

// Interface to track command execution results
interface ExecutionResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode?: number;
}

export class CommandRunner {
  private terminal: vscode.Terminal | undefined;
  private configProvider: ConfigProvider;
  private outputChannel: vscode.OutputChannel;
  private jobOutputService: JobOutputService;
  private dockerRunner: DockerRunner;
  private ignoreProvider: IgnoreProvider;
  private variableManager: VariableManager;

  constructor(context?: vscode.ExtensionContext) {
    this.configProvider = new ConfigProvider();
    this.outputChannel = vscode.window.createOutputChannel('Niobium');
    this.jobOutputService = context ? JobOutputService.getInstance(context) : null as any;
    this.dockerRunner = new DockerRunner(context);
    this.ignoreProvider = IgnoreProvider.getInstance();
    this.variableManager = VariableManager.getInstance();
  }

  /**
   * Check if a path should be ignored based on .niobiumignore patterns
   * @param filePath Path to check (relative to workspace root)
   * @param workspaceRoot Workspace root path
   * @returns True if the path should be ignored
   */
  private shouldIgnorePath(filePath: string, workspaceRoot: string): boolean {
    // Get path relative to workspace root
    let relativePath = filePath;
    if (filePath.startsWith(workspaceRoot)) {
      relativePath = path.relative(workspaceRoot, filePath);
    }
    
    // Normalize path separators
    relativePath = relativePath.replace(/\\/g, '/');
    
    return this.ignoreProvider.isIgnored(relativePath);
  }

  /**
   * Process a command string by replacing variables with their values
   * @param commandStr The command string with variables to replace
   * @returns The command string with variables replaced
   */
  private processVariables(commandStr: string): string {
    // Get all variables
    const variables = this.variableManager.getAllVariables();
    
    // Replace all ${VAR_NAME} and $VAR_NAME patterns
    let processedCommand = commandStr;
    
    // First, replace ${VAR_NAME} pattern (safer as it has boundaries)
    for (const [key, value] of Object.entries(variables)) {
      const pattern = new RegExp(`\\$\\{${key}\\}`, 'g');
      processedCommand = processedCommand.replace(pattern, value);
    }
    
    // Then replace $VAR_NAME pattern (more prone to false positives)
    for (const [key, value] of Object.entries(variables)) {
      const pattern = new RegExp(`\\$${key}\\b`, 'g');
      processedCommand = processedCommand.replace(pattern, value);
    }
    
    return processedCommand;
  }

  /**
   * Extract output variables from command output using the outputs configuration
   * @param command The command configuration with outputs defined
   * @param stdout The stdout from the command execution
   */
  private extractOutputVariables(command: CommandConfig, stdout: string): void {
    if (!command.outputs) {
      return;
    }
    
    this.outputChannel.appendLine(`\n[Variables] Extracting output variables for command: ${command.name}`);
    
    for (const [outputName, _] of Object.entries(command.outputs)) {
      // Look for ::set-output name=OUTPUT_NAME::VALUE pattern
      const setOutputRegex = new RegExp(`::set-output name=${outputName}::(.*)`, 'i');
      const match = stdout.match(setOutputRegex);
      
      if (match && match[1]) {
        const value = match[1].trim();
        this.variableManager.setVariable(outputName, value);
        this.outputChannel.appendLine(`[Variables] Extracted ${outputName}=${value}`);
        
        // Also log to job output if available
        if (this.jobOutputService) {
          this.jobOutputService.appendOutput(command.name, `\n[Variables] Set ${outputName}=${value}`);
        }
      }
    }
  }

  /**
   * Check if a command has dependencies and if they have been run
   * @param command The command to check dependencies for
   * @param executedCommands List of already executed command names
   * @returns True if dependencies are satisfied, false otherwise
   */
  private areDependenciesSatisfied(command: CommandConfig, executedCommands: string[]): boolean {
    if (!command.depends_on) {
      return true;
    }
    
    const dependencies = Array.isArray(command.depends_on) ? command.depends_on : [command.depends_on];
    
    for (const dependency of dependencies) {
      if (!executedCommands.includes(dependency)) {
        this.outputChannel.appendLine(`\n[ERROR] Dependency "${dependency}" for command "${command.name}" has not been executed`);
        return false;
      }
    }
    
    return true;
  }

  // Helper function to strip ANSI color codes from string
  private stripAnsiCodes(text: string): string {
    // First try with regex for standard ANSI escape sequences
    const basic = text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
    
    // Then strip any non-printable control characters (anything below ASCII 32 except newline and tab)
    return basic.replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '');
  }

  // New method to save command output to a file with an optional alternative filename
  private async saveOutputToFile(command: CommandConfig, output: string, workspaceRoot: string, alternativeFilename?: string): Promise<void> {
    if (!command.output_file && !alternativeFilename) {
      return;
    }
    
    try {
      // Process variables in the output file path
      const outputFilename = alternativeFilename || this.processVariables(command.output_file!);
      
      // Create .niobium_results directory if it doesn't exist
      const resultsDir = path.join(workspaceRoot, '.niobium_results');
      if (!fs.existsSync(resultsDir)) {
        fs.mkdirSync(resultsDir, { recursive: true });
      }
      
      // Construct the full output file path - normalize to handle trailing periods
      const sanitizedOutputFilename = outputFilename.replace(/\.+$/, ''); // Remove any trailing periods
      // Just use the basename instead of full path to avoid creating subdirectories
      const baseFilename = path.basename(sanitizedOutputFilename);
      const outputFilePath = path.join(resultsDir, baseFilename);
      
      // Check if this output file path should be ignored based on .niobiumignore patterns
      const relativeOutputPath = path.relative(workspaceRoot, outputFilePath);
      if (this.shouldIgnorePath(relativeOutputPath, workspaceRoot)) {
        this.outputChannel.appendLine(`\n[WARNING] Output file "${relativeOutputPath}" matches an ignore pattern in .niobiumignore. Skipping file creation.`);
        return;
      }
      
      // For JSON files, try to extract and prettify the JSON
      if (baseFilename.endsWith('.json')) {
        try {
          // Find the JSON structure start and end
          const jsonStart = Math.max(0, output.indexOf('{'));
          const jsonStartArray = output.indexOf('[');
          const startPos = (jsonStartArray !== -1 && (jsonStartArray < jsonStart || jsonStart === -1)) 
            ? jsonStartArray 
            : jsonStart;
          
          if (startPos !== -1) {
            // Find matching end - count braces/brackets to handle nested structures
            let endPos = -1;
            let depth = 0;
            const startChar = output.charAt(startPos);
            const endChar = startChar === '{' ? '}' : ']';
            
            for (let i = startPos; i < output.length; i++) {
              const char = output.charAt(i);
              if ((char === '{' && startChar === '{') || (char === '[' && startChar === '[')) {
                depth++;
              } else if ((char === '}' && startChar === '{') || (char === ']' && startChar === '[')) {
                depth--;
                if (depth === 0) {
                  endPos = i + 1;
                  break;
                }
              }
            }
            
            if (endPos !== -1) {
              // Extract JSON content
              const jsonContent = output.substring(startPos, endPos);
              
              try {
                // Try to parse and format it
                const parsedJson = JSON.parse(jsonContent);
                fs.writeFileSync(outputFilePath, JSON.stringify(parsedJson, null, 2));
                this.outputChannel.appendLine(`\n[Output] Formatted JSON saved to ${outputFilePath}`);
                return;
              } catch (parseError) {
                // Parsing failed, fall back to direct write
                this.outputChannel.appendLine(`\n[WARNING] JSON parsing failed: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
              }
            }
          }
        } catch (error) {
          // Error in JSON extraction, fall back to direct write
          this.outputChannel.appendLine(`\n[WARNING] JSON extraction failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      
      // For non-JSON files or if JSON parsing failed, write directly
      fs.writeFileSync(outputFilePath, output);
      
      this.outputChannel.appendLine(`\n[Output] Results saved to ${outputFilePath}`);
    } catch (error) {
      this.outputChannel.appendLine(`\n[ERROR] Failed to save output to file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async runCommand(command: CommandConfig, workspaceRoot: string): Promise<ExecutionResult> {
    // If the command has an image property, run it as a Docker container
    if (command.image) {
      return this.runDockerCommand(command, workspaceRoot);
    }

    // Otherwise, run it as a regular command
    // Show output channel so users can see scan output
    this.outputChannel.show(true);
    this.outputChannel.appendLine(`\n[Command] Running: ${command.name}`);
    if (command.description) {
      this.outputChannel.appendLine(`Description: ${command.description}`);
    }
    
    // Process variables in the command string
    const processedCommand = this.processVariables(command.command);
    this.outputChannel.appendLine(`Command: ${processedCommand}`);
    
    if (command.cwd) {
      this.outputChannel.appendLine(`Working directory: ${command.cwd}`);
    }
    
    if (command.env && Object.keys(command.env).length > 0) {
      this.outputChannel.appendLine('Environment variables:');
      for (const [key, value] of Object.entries(command.env)) {
        const processedValue = this.processVariables(value);
        this.outputChannel.appendLine(`  ${key}=${processedValue}`);
        // Update the env object with processed values for actual execution
        command.env[key] = processedValue;
      }
    }

    if (command.allow_failure) {
      this.outputChannel.appendLine(`Note: This command is allowed to fail (allow_failure: true)`);
    }
    
    // Record start time
    const startTime = new Date();
    this.outputChannel.appendLine(`Starting at: ${startTime.toLocaleTimeString()}`);
    
    // Create job in web view if JobOutputService is available
    let jobId: string | undefined;
    if (this.jobOutputService) {
      jobId = this.jobOutputService.startCommand(command);
    }

    // Execute the command with output
    try {
      // Determine the working directory
      const cwd = command.cwd
        ? path.resolve(workspaceRoot, command.cwd)
        : workspaceRoot;
      
      // Check if the working directory is in an ignored path
      if (this.shouldIgnorePath(cwd, workspaceRoot)) {
        const errorMsg = `Working directory "${command.cwd}" is in an ignored path according to .niobiumignore`;
        this.outputChannel.appendLine(`\n[ERROR] ${errorMsg}`);
        if (jobId) {
          this.jobOutputService.appendError(jobId, errorMsg);
          this.jobOutputService.completeJobFailure(jobId, 1);
        }
        return {
          success: false,
          output: '',
          error: errorMsg,
          exitCode: 1
        };
      }
      
      // Set environment variables
      const env = { ...process.env };
      if (command.env) {
        Object.assign(env, command.env);
      }

      // Execute the command and capture output
      const execOptions: cp.ExecOptions = {
        cwd,
        env
      };
      
      // Default shell command
      let shellExecutable = '/bin/bash';
      if (process.platform === 'win32') {
        shellExecutable = 'cmd.exe';
      } else if (process.platform === 'darwin') {
        // On macOS Catalina and later, zsh is the default shell
        shellExecutable = '/bin/zsh';
      }
      
      // Set shell based on command.shell if provided
      if (command.shell !== undefined) {
        if (typeof command.shell === 'string') {
          execOptions.shell = command.shell;
        } else if (command.shell === false) {
          // Direct execution without shell
          execOptions.shell = undefined;
        } else {
          execOptions.shell = shellExecutable;
        }
      } else {
        // Default to using shell
        execOptions.shell = shellExecutable;
      }
      
      // Set up for cancelable command execution
      let childProcess: cp.ChildProcess | null = null;
      let canceled = false;
      let detectedPorts: number[] = [];
      let childPids: number[] = [];
      
      // Try to detect which ports this command will use
      const detectedServerPorts = this.detectPossiblePorts(processedCommand);
      if (detectedServerPorts.length > 0) {
        this.outputChannel.appendLine(`\n[INFO] Detected possible ports: ${detectedServerPorts.join(', ')}`);
      }
      
      // Register kill handler if JobOutputService is available
      if (jobId && this.jobOutputService) {
        this.jobOutputService.registerKillHandler(jobId, async () => {
          if (childProcess && childProcess.pid) {
            this.outputChannel.appendLine(`\n[INFO] Kill request received for command: ${command.name}`);
            canceled = true;
            
            try {
              await this.killProcessAndChildren(childProcess, command, detectedPorts, childPids);
              
              this.jobOutputService.appendOutput(jobId!, '\n[System] Command terminated by user');
              this.jobOutputService.completeJobFailure(jobId!, 130); // 130 is the exit code for SIGTERM
            } catch (killError) {
              const errorMessage = killError instanceof Error ? killError.message : String(killError);
              this.outputChannel.appendLine(`\n[ERROR] Failed to kill process: ${errorMessage}`);
              this.jobOutputService.appendError(jobId!, `\n[System] Failed to terminate command: ${errorMessage}`);
              this.jobOutputService.completeJobFailure(jobId!, 1);
            }
          }
        });
      }
      
      // Custom promise-based exec with cancellation support
      const execResult = await new Promise<{stdout: string, stderr: string, code: number}>((resolve, reject) => {
        // If on Unix systems, spawn with options for process group management
        const execOptionsWithDetached = process.platform !== 'win32' 
          ? { ...execOptions, windowsHide: true } 
          : execOptions;
        
        childProcess = cp.exec(processedCommand, execOptionsWithDetached);
        
        // Register the process PID with the job output service for tracking
        if (childProcess.pid && jobId) {
          console.log(`CommandRunner: Registering PID ${childProcess.pid} for job ${jobId} (${command.name})`);
          this.jobOutputService.registerPid(jobId, childProcess.pid);
        } else {
          console.log(`CommandRunner: Failed to register PID for job ${jobId} - ${childProcess.pid ? 'no jobId' : 'no PID'} (${command.name})`);
        }
        
        // Set up periodic checks to detect child processes and port usage
        const portCheckInterval = setInterval(async () => {
          if (!childProcess || !childProcess.pid) {
            clearInterval(portCheckInterval);
            return;
          }
          
          try {
            // Check for processes that are children of our main process
            const newChildPids = await this.findChildProcesses(childProcess.pid);
            if (newChildPids.length > 0) {
              const newPids = newChildPids.filter(pid => !childPids.includes(pid));
              if (newPids.length > 0) {
                childPids = [...childPids, ...newPids];
                this.outputChannel.appendLine(`\n[INFO] Detected child processes: ${newPids.join(', ')}`);
                
                if (jobId) {
                  this.jobOutputService.updateJob(jobId, { childPids });
                }
              }
            }
            
            // Check for ports that have been opened by our process tree
            if (detectedServerPorts.length > 0) {
              const allPids = [childProcess.pid, ...childPids];
              const activePortsInfo = await this.checkPortsInUse(detectedServerPorts, allPids);
              
              if (activePortsInfo.length > 0) {
                const currentPorts = activePortsInfo.map(p => p.port);
                const newPorts = currentPorts.filter(port => !detectedPorts.includes(port));
                
                if (newPorts.length > 0) {
                  detectedPorts = [...detectedPorts, ...newPorts];
                  this.outputChannel.appendLine(`\n[INFO] Detected active ports: ${newPorts.join(', ')}`);
                  
                  if (jobId) {
                    this.jobOutputService.updateJob(jobId, { ports: detectedPorts });
                  }
                }
              }
            }
          } catch (error) {
            // Ignore errors in the background checks
          }
        }, 2000);
        
        let stdout = '';
        let stderr = '';
        
        childProcess.stdout?.on('data', (data) => {
          const text = data.toString();
          stdout += text;
          
          // Scan output for port information
          const portMatches = text.match(/(?:listening on|running on|localhost:|server running|started on|listening at|bound to|port\s*:)(?:.*?)(\d{2,5})/gi);
          if (portMatches) {
            portMatches.forEach((match: string) => {
              const portMatch = match.match(/(\d{2,5})/);
              if (portMatch && portMatch[1]) {
                const port = parseInt(portMatch[1], 10);
                if (port > 0 && port < 65536 && !detectedPorts.includes(port)) {
                  detectedPorts.push(port);
                  this.outputChannel.appendLine(`\n[INFO] Detected port from output: ${port}`);
                  
                  if (jobId) {
                    this.jobOutputService.updateJob(jobId, { ports: detectedPorts });
                  }
                }
              }
            });
          }
          
          // Show real-time output
          this.outputChannel.append(text);
          
          // Add output to WebView if available
          if (jobId) {
            this.jobOutputService.appendOutput(jobId, text);
          }
        });
        
        childProcess.stderr?.on('data', (data) => {
          const text = data.toString();
          stderr += text;
          
          // Show real-time output
          this.outputChannel.append(text);
          
          // Add error to WebView if available
          if (jobId) {
            this.jobOutputService.appendError(jobId, text);
          }
        });
        
        childProcess.on('close', (code) => {
          clearInterval(portCheckInterval);
          
          if (canceled) {
            // If the command was canceled, we've already handled this case
            return;
          }
          
          if (code === 0) {
            resolve({ stdout, stderr, code });
          } else {
            const error: any = new Error(`Command failed with exit code ${code}`);
            error.code = code;
            error.stdout = stdout;
            error.stderr = stderr;
            reject(error);
          }
        });
        
        childProcess.on('error', (error) => {
          clearInterval(portCheckInterval);
          reject(error);
        });
      });
      
      // Extract output variables if specified in the command
      this.extractOutputVariables(command, execResult.stdout);
      
      // Save output to file if output_file is specified
      await this.saveOutputToFile(command, execResult.stdout, workspaceRoot);
      
      // Write output to the output channel
      // No need to append stdout/stderr again as we've already done it in real-time
      
      // Record end time
      const endTime = new Date();
      const executionTime = (endTime.getTime() - startTime.getTime()) / 1000;
      this.outputChannel.appendLine(`\nCompleted at: ${endTime.toLocaleTimeString()}`);
      this.outputChannel.appendLine(`Execution time: ${executionTime.toFixed(2)}s`);
      this.outputChannel.appendLine(`Exit status: Success`);
      this.outputChannel.appendLine('─'.repeat(80)); // Separator line
      
      vscode.window.showInformationMessage(`Command completed successfully: ${command.name}`);
      
      // Mark job as complete in WebView if available
      if (jobId) {
        this.jobOutputService.completeJobSuccess(jobId);
      }
      
      // Return successful result
      return {
        success: true,
        output: execResult.stdout,
        exitCode: 0
      };
    } catch (error) {
      // Handle command execution error
      const exitCode = (error as any).code || 1;
      const stderr = (error as any).stderr || String(error);
      const stdout = (error as any).stdout || '';
      
      // Write output to the output channel
      if (stdout) {
        this.outputChannel.appendLine('\n[OUTPUT]');
        this.outputChannel.appendLine(stdout);
        
        // Save output to file even on failure if output_file is specified
        await this.saveOutputToFile(command, stdout, workspaceRoot);
        
        // Add output to WebView if available
        if (jobId) {
          this.jobOutputService.appendOutput(jobId, stdout);
        }
      }
      
      this.outputChannel.appendLine('\n[ERROR]');
      this.outputChannel.appendLine(stderr);
      
      // Add error to WebView if available
      if (jobId) {
        this.jobOutputService.appendError(jobId, stderr);
      }
      
      // Record end time
      const endTime = new Date();
      const executionTime = (endTime.getTime() - startTime.getTime()) / 1000;
      this.outputChannel.appendLine(`\nFailed at: ${endTime.toLocaleTimeString()}`);
      this.outputChannel.appendLine(`Execution time: ${executionTime.toFixed(2)}s`);
      this.outputChannel.appendLine(`Exit code: ${exitCode}`);
      this.outputChannel.appendLine('─'.repeat(80)); // Separator line
      
      // Different message based on if the failure is allowed
      if (command.allow_failure) {
        this.outputChannel.appendLine(`Command failed but continuing (allow_failure: true)`);
        vscode.window.showWarningMessage(`Command failed but continuing: ${command.name}`);
        
        // Mark job as failed in WebView but indicate it's allowed to fail
        if (jobId) {
          this.jobOutputService.completeJobFailure(jobId, exitCode);
        }
      } else {
        vscode.window.showErrorMessage(`Command failed: ${command.name}`);
        
        // Mark job as failed in WebView
        if (jobId) {
          this.jobOutputService.completeJobFailure(jobId, exitCode);
        }
      }
      
      // Return failed result
      return {
        success: false,
        output: stdout,
        error: stderr,
        exitCode
      };
    }
  }

  async runStage(config: NiobiumConfig, stageName: string, workspaceRoot: string): Promise<ExecutionResult> {
    // Show output channel so users can see scan output
    this.outputChannel.show(true);
    
    const stage = this.configProvider.findStage(config, stageName);
    if (!stage) {
      const errorMsg = `Stage "${stageName}" not found`;
      this.outputChannel.appendLine(`\n[ERROR] ${errorMsg}`);
      vscode.window.showErrorMessage(errorMsg);
      return { success: false, output: '', error: errorMsg };
    }

    this.outputChannel.appendLine(`\n${'='.repeat(80)}`);
    this.outputChannel.appendLine(`[Stage] Running: ${stage.name}`);
    if (stage.description) {
      this.outputChannel.appendLine(`Description: ${stage.description}`);
    }
    if (stage.allow_failure) {
      this.outputChannel.appendLine(`Note: This stage is allowed to fail (allow_failure: true)`);
    }
    if (stage.parallel) {
      this.outputChannel.appendLine(`Note: Commands will run in parallel (parallel: true)`);
    }
    this.outputChannel.appendLine(`${'='.repeat(80)}`);
    
    vscode.window.showInformationMessage(`Running stage: ${stage.name}`);
    
    // Create stage job in WebView if JobOutputService is available
    let stageJobId: string | undefined;
    if (this.jobOutputService) {
      stageJobId = this.jobOutputService.startStage(stage);
    }
    
    const commands = this.configProvider.getStageCommands(config, stageName);
    if (commands.length === 0) {
      const warningMsg = `No valid commands found in stage "${stageName}"`;
      this.outputChannel.appendLine(`[WARNING] ${warningMsg}`);
      vscode.window.showWarningMessage(warningMsg);
      
      if (stageJobId) {
        this.jobOutputService.appendOutput(stageJobId, `Warning: ${warningMsg}`);
        this.jobOutputService.completeJobFailure(stageJobId);
      }
      
      return { success: false, output: '', error: warningMsg };
    }

    // Record start time
    const stageStartTime = new Date();
    this.outputChannel.appendLine(`Stage started at: ${stageStartTime.toLocaleTimeString()}`);
    this.outputChannel.appendLine(`Total commands to execute: ${commands.length}`);
    this.outputChannel.appendLine(`Execution mode: ${stage.parallel ? 'Parallel' : 'Sequential'}`);
    
    let stageSuccess = true;
    let combinedOutput = '';
    let executedCommands: string[] = [];
    
    if (stage.parallel) {
      // Execute commands in parallel
      this.outputChannel.appendLine(`Running all commands in parallel`);
      
      const runningCommands = commands.map(async (command, index) => {
        const commandIndex = index + 1;
        this.outputChannel.appendLine(`\n[${commandIndex}/${commands.length}] Starting command in parallel: ${command.name}`);
        
        // Check if command dependencies are satisfied
        if (!this.areDependenciesSatisfied(command, executedCommands)) {
          const error = `Cannot run command "${command.name}" because its dependencies have not been executed`;
          this.outputChannel.appendLine(`\n[ERROR] ${error}`);
          
          if (!command.allow_failure) {
            return { 
              success: false, 
              output: '', 
              error, 
              exitCode: 1,
              commandName: command.name
            };
          }
          
          return {
            success: true,
            output: `Command skipped due to unsatisfied dependencies: ${command.name}`,
            commandName: command.name
          };
        }
        
        try {
          const result = await this.runCommand(command, workspaceRoot);
          
          // Track executed commands for dependency checking - we need to be careful with race conditions here
          executedCommands.push(command.name);
          
          // If this command had a WebView job, add it as child of the stage
          if (stageJobId && this.jobOutputService) {
            // Get the command's job ID from active jobs
            const commandJob = [...this.jobOutputService['activeJobs'].values()]
              .find(job => job.type === 'command' && job.name === command.name);
            
            if (commandJob) {
              this.jobOutputService.addChildJob(stageJobId, commandJob.id);
            }
          }
          
          return {
            ...result,
            commandName: command.name
          };
        } catch (error) {
          return {
            success: false,
            output: '',
            error: String(error),
            commandName: command.name
          };
        }
      });
      
      // Wait for all commands to complete
      const results = await Promise.all(runningCommands);
      
      // Process results
      for (const result of results) {
        combinedOutput += `\n--- Command: ${result.commandName} ---\n${result.output || ''}\n`;
        
        if (!result.success && !commands.find(c => c.name === result.commandName)?.allow_failure) {
          stageSuccess = false;
          this.outputChannel.appendLine(`\nCommand "${result.commandName}" failed with${result.error ? ': ' + result.error : ' an error'}`);
        }
      }
    } else {
      // Original sequential execution logic
      let commandIndex = 0;
      
      for (const command of commands) {
        commandIndex++;
        this.outputChannel.appendLine(`\n[${commandIndex}/${commands.length}] Executing command: ${command.name}`);
        
        // Check if command dependencies are satisfied
        if (!this.areDependenciesSatisfied(command, executedCommands)) {
          const error = `Cannot run command "${command.name}" because its dependencies have not been executed`;
          this.outputChannel.appendLine(`\n[ERROR] ${error}`);
          
          if (!command.allow_failure) {
            return { 
              success: false, 
              output: combinedOutput, 
              error: error, 
              exitCode: 1
            };
          }
          
          continue;
        }
        
        const result = await this.runCommand(command, workspaceRoot);
        combinedOutput += result.output + '\n';
        
        // Track executed commands for dependency checking
        executedCommands.push(command.name);
        
        // If this command had a WebView job, add it as child of the stage
        if (stageJobId && this.jobOutputService) {
          // Get the command's job ID from active jobs
          const commandJob = [...this.jobOutputService['activeJobs'].values()]
            .find(job => job.type === 'command' && job.name === command.name);
          
          if (commandJob) {
            this.jobOutputService.addChildJob(stageJobId, commandJob.id);
          }
        }
        
        // If the command failed and doesn't allow failure, stop the stage
        if (!result.success && !command.allow_failure) {
          stageSuccess = false;
          this.outputChannel.appendLine(`Command failed. Stopping stage execution since allow_failure is not set.`);
          break;
        }
        
        // Add a small delay between commands
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    // Record end time
    const stageEndTime = new Date();
    const stageExecutionTime = (stageEndTime.getTime() - stageStartTime.getTime()) / 1000;
    this.outputChannel.appendLine(`\nStage ${stageSuccess ? 'completed' : 'failed'} at: ${stageEndTime.toLocaleTimeString()}`);
    this.outputChannel.appendLine(`Total stage execution time: ${stageExecutionTime.toFixed(2)}s`);
    this.outputChannel.appendLine(`Exit status: ${stageSuccess ? 'Success' : 'Failure'}`);
    this.outputChannel.appendLine(`${'='.repeat(80)}`);

    // Determine if the stage allows failure
    const stageFailed = !stageSuccess;
    
    if (stageFailed) {
      if (stage.allow_failure) {
        this.outputChannel.appendLine(`Stage failed but continuing (allow_failure: true)`);
        vscode.window.showWarningMessage(`Stage failed but continuing: ${stage.name}`);
        
        // Mark stage as failed in WebView but indicate it's allowed to fail
        if (stageJobId && this.jobOutputService) {
          // Make sure any still-running child jobs are also marked as complete
          this.cleanupStageJobs(stageJobId);
          // Then mark the stage as failed
          this.jobOutputService.completeJobFailure(stageJobId);
        }
        
        return { success: true, output: combinedOutput };
      } else {
        vscode.window.showErrorMessage(`Stage failed: ${stage.name}`);
        
        // Mark stage as failed in WebView
        if (stageJobId && this.jobOutputService) {
          // Make sure any still-running child jobs are also marked as complete
          this.cleanupStageJobs(stageJobId);
          // Then mark the stage as failed
          this.jobOutputService.completeJobFailure(stageJobId);
        }
        
        return { success: false, output: combinedOutput, error: 'Stage execution failed' };
      }
    } else {
      vscode.window.showInformationMessage(`Stage completed successfully: ${stage.name}`);
      
      // Mark stage as successful in WebView
      if (stageJobId && this.jobOutputService) {
        // Make sure any still-running child jobs are also marked as complete
        this.cleanupStageJobs(stageJobId);
        // Then mark the stage as successful
        this.jobOutputService.completeJobSuccess(stageJobId);
      }
      
      return { success: true, output: combinedOutput };
    }
  }

  /**
   * Ensure all child jobs of a stage are properly completed
   * This prevents stale "running" jobs when a stage completes
   */
  private cleanupStageJobs(stageJobId: string): void {
    if (!this.jobOutputService) {
      return;
    }
    
    console.log(`Cleaning up jobs for stage ${stageJobId}`);
    
    // Get the stage job
    const stageJob = this.jobOutputService.getJob(stageJobId);
    if (!stageJob || !stageJob.children) {
      console.log(`No stage job found with ID ${stageJobId} or it has no children`);
      return;
    }
    
    console.log(`Stage "${stageJob.name}" has ${stageJob.children.length} child jobs`);
    
    // Check all child jobs and complete any that are still running
    for (const childJob of stageJob.children) {
      if (childJob.status === 'running') {
        console.log(`Completing child job ${childJob.id} (${childJob.name}) that was still running when stage completed`);
        this.jobOutputService.appendOutput(childJob.id, '\n[System] Job marked as complete because stage completed');
        this.jobOutputService.completeJobSuccess(childJob.id);
      }
    }
    
    // Also search for any jobs with the same names as child jobs that might be orphaned
    const childJobNames = new Set(stageJob.children.map(job => job.name));
    
    // Get all active jobs to look for potential duplicates
    try {
      const allActiveJobs = this.jobOutputService['activeJobs'].values();
      
      for (const job of allActiveJobs) {
        if (job.status === 'running' && childJobNames.has(job.name) && 
            !stageJob.children.some(child => child.id === job.id)) {
          console.log(`Found potential orphaned job ${job.id} (${job.name}) with same name as stage child - completing it`);
          this.jobOutputService.appendOutput(job.id, '\n[System] Job marked as complete - matches a job in completed stage');
          this.jobOutputService.completeJobSuccess(job.id);
        }
      }
    } catch (error) {
      console.error('Error checking for orphaned jobs:', error);
    }
    
    // Force a refresh of the panel to ensure UI is fully updated
    try {
      this.jobOutputService['refreshPanel']();
    } catch (error) {
      console.error('Error refreshing panel after cleaning up stage jobs:', error);
    }
  }

  async runSequence(config: NiobiumConfig, sequenceName: string, workspaceRoot: string): Promise<ExecutionResult> {
    // Show output channel so users can see scan output
    this.outputChannel.show(true);
    
    const sequence = this.configProvider.findSequence(config, sequenceName);
    if (!sequence) {
      const errorMsg = `Sequence "${sequenceName}" not found`;
      this.outputChannel.appendLine(`\n[ERROR] ${errorMsg}`);
      vscode.window.showErrorMessage(errorMsg);
      return { success: false, output: '', error: errorMsg };
    }

    this.outputChannel.appendLine(`\n${'#'.repeat(80)}`);
    this.outputChannel.appendLine(`[Sequence] Running: ${sequence.name}`);
    if (sequence.description) {
      this.outputChannel.appendLine(`Description: ${sequence.description}`);
    }
    this.outputChannel.appendLine(`${'#'.repeat(80)}`);
    
    vscode.window.showInformationMessage(`Running sequence: ${sequence.name}`);
    
    // Create sequence job in WebView if JobOutputService is available
    let sequenceJobId: string | undefined;
    if (this.jobOutputService) {
      sequenceJobId = this.jobOutputService.startSequence(sequence.name, sequence.description);
    }
    
    const stages = this.configProvider.getSequenceStages(config, sequenceName);
    if (stages.length === 0) {
      const warningMsg = `No valid stages found in sequence "${sequenceName}"`;
      this.outputChannel.appendLine(`[WARNING] ${warningMsg}`);
      vscode.window.showWarningMessage(warningMsg);
      
      if (sequenceJobId) {
        this.jobOutputService.appendOutput(sequenceJobId, `Warning: ${warningMsg}`);
        this.jobOutputService.completeJobFailure(sequenceJobId);
      }
      
      return { success: false, output: '', error: warningMsg };
    }

    // Record start time
    const sequenceStartTime = new Date();
    this.outputChannel.appendLine(`Sequence started at: ${sequenceStartTime.toLocaleTimeString()}`);
    this.outputChannel.appendLine(`Total stages to execute: ${stages.length}`);
    
    // Execute each stage in sequence
    let stageIndex = 0;
    let sequenceSuccess = true;
    let combinedOutput = '';
    
    for (const stage of stages) {
      stageIndex++;
      this.outputChannel.appendLine(`\n[${stageIndex}/${stages.length}] Executing stage: ${stage.name}`);
      
      const result = await this.runStage(config, stage.name, workspaceRoot);
      combinedOutput += result.output + '\n';
      
      // If this stage had a WebView job, add it as child of the sequence
      if (sequenceJobId && this.jobOutputService) {
        // Get the stage's job ID from active jobs
        const stageJob = [...this.jobOutputService['activeJobs'].values()]
          .find(job => job.type === 'stage' && job.name === stage.name);
        
        if (stageJob) {
          this.jobOutputService.addChildJob(sequenceJobId, stageJob.id);
        }
      }
      
      // If the stage failed and doesn't have allow_failure, stop the sequence
      if (!result.success) {
        sequenceSuccess = false;
        this.outputChannel.appendLine(`Stage failed. Stopping sequence execution.`);
        break;
      }
      
      // Add a small delay between stages
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Record end time
    const sequenceEndTime = new Date();
    const sequenceExecutionTime = (sequenceEndTime.getTime() - sequenceStartTime.getTime()) / 1000;
    this.outputChannel.appendLine(`\nSequence ${sequenceSuccess ? 'completed' : 'failed'} at: ${sequenceEndTime.toLocaleTimeString()}`);
    this.outputChannel.appendLine(`Total sequence execution time: ${sequenceExecutionTime.toFixed(2)}s`);
    this.outputChannel.appendLine(`Exit status: ${sequenceSuccess ? 'Success' : 'Failure'}`);
    this.outputChannel.appendLine(`${'#'.repeat(80)}`);

    if (sequenceSuccess) {
      vscode.window.showInformationMessage(`Sequence completed successfully: ${sequence.name}`);
      
      // Mark sequence as successful in WebView
      if (sequenceJobId) {
        this.jobOutputService.completeJobSuccess(sequenceJobId);
      }
      
      return { success: true, output: combinedOutput };
    } else {
      vscode.window.showErrorMessage(`Sequence failed: ${sequence.name}`);
      
      // Mark sequence as failed in WebView
      if (sequenceJobId) {
        this.jobOutputService.completeJobFailure(sequenceJobId);
      }
      
      return { success: false, output: combinedOutput, error: 'Sequence execution failed' };
    }
  }

  // Method to explicitly show the output channel
  showOutput(): void {
    this.outputChannel.show(true);
    
    // Always force show the WebView panel when explicitly requested
    if (this.jobOutputService) {
      this.jobOutputService.showPanel(true); // Force the panel to be shown
    }
  }

  /**
   * Run a command as a Docker container
   */
  private async runDockerCommand(command: CommandConfig, workspaceRoot: string): Promise<ExecutionResult> {
    // Don't show output channel automatically, let user open it manually if needed
    this.outputChannel.appendLine(`\n[Docker Command] Running: ${command.name}`);
    if (command.description) {
      this.outputChannel.appendLine(`Description: ${command.description}`);
    }
    this.outputChannel.appendLine(`Image: ${command.image}${command.image_tag ? `:${command.image_tag}` : ''}`);
    
    // Create .niobium_results directory if it doesn't exist
    const resultsDir = path.join(workspaceRoot, '.niobium_results');
    if (!fs.existsSync(resultsDir)) {
      fs.mkdirSync(resultsDir, { recursive: true });
    }
    
    // Add a dedicated volume for output files
    const containerName = command.container_name || `niobium-${sanitizeContainerName(command.name)}-${Date.now()}`;
    const outputVolumePath = '/output';
    
    // Process variables in the output_file path if specified
    let processedOutputFile = '';
    if (command.output_file) {
      processedOutputFile = this.processVariables(command.output_file);
      
      // Create subdirectories if needed
      if (processedOutputFile.includes('/')) {
        const outputDir = path.join(resultsDir, path.dirname(processedOutputFile));
        if (!fs.existsSync(outputDir)) {
          fs.mkdirSync(outputDir, { recursive: true });
        }
      }
    }
    
    // Create a Docker container config from the command
    const containerConfig: DockerContainerConfig = {
      name: containerName,
      description: command.description,
      image: command.image!, // Using non-null assertion as we've validated this exists
      tag: command.image_tag,
      command: command.command,
      ports: command.ports,
      volumes: (() => {
        // Check if there's already a volume with target '/output'
        const existingVolumes = command.volumes || [];
        const hasOutputVolume = existingVolumes.some(vol => vol.target === outputVolumePath);
        
        if (hasOutputVolume) {
          // If an output volume already exists, don't add another one
          this.outputChannel.appendLine(`[INFO] Using existing volume mapping for ${outputVolumePath}`);
          return existingVolumes;
        } else {
          // Otherwise, add our dedicated output volume
          return [
            ...existingVolumes,
            {
              source: resultsDir,
              target: outputVolumePath,
              readonly: false
            }
          ];
        }
      })(),
      workdir: command.workdir,
      network: command.network,
      entrypoint: command.entrypoint,
      environment: {
        // Add existing environment variables
        ...(command.env || {}),
        // Add environment variables for output paths
        NIOBIUM_OUTPUT_PATH: outputVolumePath,
        NIOBIUM_OUTPUT_FILE: processedOutputFile || ''
      },
      remove_when_stopped: command.remove_after_run
    };

    // Record start time
    const startTime = new Date();
    this.outputChannel.appendLine(`Starting at: ${startTime.toLocaleTimeString()}`);
    
    // Create job in web view if JobOutputService is available
    let jobId: string | undefined;
    if (this.jobOutputService) {
      jobId = this.jobOutputService.startCommand(command);
    }

    try {
      // Check if docker is available
      const dockerResult = await this.dockerRunner.startContainer(containerConfig, workspaceRoot);
      
      if (!dockerResult.success) {
        throw new Error(dockerResult.error || 'Unknown Docker error');
      }

      // Get the container if it exists
      const container = await this.dockerRunner.findContainer(containerConfig.name);
      if (!container) {
        throw new Error(`Container ${containerConfig.name} not found`);
      }
      
      // For one-off commands that exit quickly, wait for the container to complete
      // and capture the output
      if (containerConfig.command) {
        // Output a message that we're running the command
        this.outputChannel.appendLine(`\n[COMMAND] ${containerConfig.command}`);
        
        // Wait for the container to exit without a timeout
        await container.wait();
        
        // Get the logs
        const logStream = await container.logs({
          follow: false,
          stdout: true,
          stderr: true,
          tail: -1  // Use -1 to get all logs
        });
        
        // Get raw logs and sanitize them for output display only
        const logs = this.sanitizeDockerOutput(logStream.toString());
        this.outputChannel.appendLine(`\n[OUTPUT]`);
        this.outputChannel.appendLine(logs);
        
        // Check for output files in the volume directory (which is mapped to .niobium_results)
        const outputFiles: string[] = [];
        this.listFilesRecursively(resultsDir, outputFiles);
        
        // Filter output files based on ignore patterns - this is redundant since listFilesRecursively already
        // filters files, but an extra check doesn't hurt as a safety measure
        const filteredOutputFiles = outputFiles.filter(file => !this.shouldIgnorePath(file, workspaceRoot));
        
        // If we have output files, log them
        if (filteredOutputFiles.length > 0) {
          this.outputChannel.appendLine(`\n[FILES] Output files in .niobium_results directory:`);
          filteredOutputFiles.forEach(file => {
            this.outputChannel.appendLine(`- ${file}`);
          });
        } else if (command.output_file) {
          // If no files were found but an output file was specified, try to create it from logs
          // Keep original path structure but ensure the directory exists
          const outputPath = path.join(resultsDir, processedOutputFile);
          const relativeOutputPath = path.relative(workspaceRoot, outputPath);
          
          // Check if this output file path should be ignored based on .niobiumignore patterns
          if (this.shouldIgnorePath(relativeOutputPath, workspaceRoot)) {
            this.outputChannel.appendLine(`\n[WARNING] Output file "${relativeOutputPath}" matches an ignore pattern in .niobiumignore. Skipping file creation.`);
          } else {
            const outputDir = path.dirname(outputPath);
            
            if (!fs.existsSync(outputDir)) {
              fs.mkdirSync(outputDir, { recursive: true });
            }
            
            // Simply save the raw logs to the file
            fs.writeFileSync(outputPath, logs);
            this.outputChannel.appendLine(`\n[INFO] Container did not create output files. Saving logs to: ${outputPath}`);
          }
        }
        
        if (jobId) {
          this.jobOutputService.appendOutput(jobId, logs);
        }
      }
      
      // Return successful result
      return {
        success: true,
        output: dockerResult.output,
        exitCode: 0
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.outputChannel.appendLine(`\n[ERROR] ${errorMessage}`);
      
      if (jobId) {
        this.jobOutputService.appendError(jobId, errorMessage);
        this.jobOutputService.completeJobFailure(jobId, 1);
      }
      
      // Clean up container if needed
      if (containerConfig.remove_when_stopped) {
        await this.dockerRunner.removeContainer(containerConfig.name);
      }
      
      return {
        success: false,
        output: '',
        error: errorMessage,
        exitCode: 1
      };
    }
  }
  
  /**
   * Sanitizes docker output to remove control characters and normalize line endings
   */
  private sanitizeDockerOutput(output: string): string {
    if (!output) {
      return '';
    }
    
    // Thorough cleaning of Docker output
    const sanitized = output
      // Remove ANSI color codes and escape sequences
      .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
      // Remove common non-printable ASCII and Unicode control characters
      .replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F-\x9F\u0080-\u00A0]/g, '')
      // Clean up any broken UTF-8 sequences that might appear as replacement characters
      .replace(/\uFFFD/g, '')
      // Normalize line endings
      .replace(/\r\n/g, '\n');
    
    return sanitized;
  }
  
  /**
   * Kill a process, its children, and processes using the same ports
   */
  private async killProcessAndChildren(
    childProcess: cp.ChildProcess, 
    command: CommandConfig, 
    detectedPorts: number[] = [], 
    childPids: number[] = []
  ): Promise<void> {
    if (!childProcess.pid) return;
    
    this.outputChannel.appendLine(`\n[INFO] Attempting to kill process ${childProcess.pid} and its children`);
    
    // Build up a full list of target PIDs
    const allPids = new Set<number>([childProcess.pid, ...childPids]);
    
    // Find any additional child processes we might have missed
    try {
      const additionalPids = await this.findChildProcesses(childProcess.pid);
      additionalPids.forEach(pid => allPids.add(pid));
    } catch (e) {
      // Ignore errors finding child processes
    }
    
    this.outputChannel.appendLine(`\n[INFO] Target PIDs: ${[...allPids].join(', ')}`);
    
    // Ensure we check the most common Node.js server ports for Vite and Express/Node
    const criticalPorts = new Set([...detectedPorts]);
    if (command.command.includes('npm run dev') || command.command.includes('vite')) {
      criticalPorts.add(5173); // Vite default
    }
    if (command.command.includes('npm run start') || command.command.includes('node server')) {
      criticalPorts.add(5000); // Default in the shown output
      criticalPorts.add(3000); // Common Express/React port
    }
    
    // Check if any specific ports are being used and find those processes
    if (criticalPorts.size > 0) {
      try {
        const portsArray = [...criticalPorts];
        this.outputChannel.appendLine(`\n[INFO] Checking port usage for ports: ${portsArray.join(', ')}`);
        const portInfo = await this.checkPortsInUse(portsArray);
        
        for (const info of portInfo) {
          this.outputChannel.appendLine(`\n[INFO] Port ${info.port} used by PID: ${info.pid}`);
          if (info.pid && !allPids.has(info.pid)) {
            allPids.add(info.pid);
            
            try {
              // Also get any child processes of this port-using process
              const morePids = await this.findChildProcesses(info.pid);
              morePids.forEach(pid => allPids.add(pid));
            } catch (e) {
              // Ignore errors finding child processes
            }
          }
        }
      } catch (e) {
        this.outputChannel.appendLine(`\n[WARNING] Error checking port usage: ${e}`);
      }
    }
    
    // Now we have a list of all processes to kill, including:
    // 1. The main process
    // 2. All its children
    // 3. Any process using the detected ports
    // 4. Children of those port-using processes
    
    if (process.platform === 'win32') {
      // Windows process killing
      for (const pid of allPids) {
        try {
          await new Promise<void>(resolve => {
            cp.exec(`taskkill /pid ${pid} /T /F`, (error) => {
              if (error) {
                this.outputChannel.appendLine(`\n[WARNING] Error killing PID ${pid}: ${error.message}`);
              } else {
                this.outputChannel.appendLine(`\n[INFO] Successfully killed PID ${pid}`);
              }
              resolve();
            });
          });
        } catch (e) {
          // Ignore individual kill errors
        }
      }
      
      // Additional process killing for Node.js-based commands
      if (command.command.includes('npm') || command.command.includes('node')) {
        const scriptName = command.command.match(/(?:npm run\s+|node\s+)(\w+)/)?.[1];
        
        if (scriptName) {
          this.outputChannel.appendLine(`\n[INFO] Additional cleanup for Node.js script: ${scriptName}`);
          try {
            await new Promise<void>(resolve => {
              cp.exec(`taskkill /F /FI "IMAGENAME eq node.exe" /FI "WINDOWTITLE eq *${scriptName}*"`, () => {
                this.outputChannel.appendLine(`\n[INFO] Completed Node.js process cleanup`);
                resolve();
              });
            });
          } catch (e) {
            // Ignore errors in auxiliary cleanup
          }
        }
      }
      
      // Kill processes by port (Windows)
      for (const port of detectedPorts) {
        try {
          await new Promise<void>(resolve => {
            cp.exec(`for /f "tokens=5" %a in ('netstat -aon ^| find ":${port}"') do taskkill /F /PID %a`, () => {
              this.outputChannel.appendLine(`\n[INFO] Attempted cleanup of processes using port ${port}`);
              resolve();
            });
          });
        } catch (e) {
          // Ignore errors in auxiliary cleanup
        }
      }
      
      // Final failsafe - directly kill any processes on critical ports
      // This is a last resort if the regular killing didn't work
      for (const port of criticalPorts) {
        try {
          await new Promise<void>(resolve => {
            // This is more aggressive and will kill any process holding the port
            cp.exec(`for /f "tokens=5" %a in ('netstat -aon ^| find ":${port} "') do taskkill /F /PID %a`, () => {
              this.outputChannel.appendLine(`\n[INFO] Forced cleanup of processes using port ${port}`);
              resolve();
            });
          });
        } catch (e) {
          // Ignore errors in cleanup
        }
      }
    } else {
      // Unix process killing - more straightforward
      for (const pid of allPids) {
        try {
          process.kill(pid, 'SIGTERM');
          this.outputChannel.appendLine(`\n[INFO] Sent SIGTERM to PID ${pid}`);
        } catch (e) {
          // Process might already be gone
        }
      }
      
      // Allow a small delay for SIGTERM to work
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Follow up with SIGKILL for any process that didn't terminate
      for (const pid of allPids) {
        try {
          process.kill(pid, 'SIGKILL');
          this.outputChannel.appendLine(`\n[INFO] Sent SIGKILL to PID ${pid}`);
        } catch (e) {
          // Process might already be gone, which is good
        }
      }
      
      // Also try killing by port (Unix)
      for (const port of detectedPorts) {
        try {
          await new Promise<void>(resolve => {
            cp.exec(`lsof -i:${port} -t | xargs kill -9`, () => {
              this.outputChannel.appendLine(`\n[INFO] Attempted cleanup of processes using port ${port}`);
              resolve();
            });
          });
        } catch (e) {
          // Ignore errors in auxiliary cleanup
        }
      }
      
      // Kill any related npm/node processes
      if (command.command.includes('npm') || command.command.includes('node')) {
        const scriptName = command.command.match(/(?:npm run\s+|node\s+)(\w+)/)?.[1];
        
        if (scriptName) {
          this.outputChannel.appendLine(`\n[INFO] Additional cleanup for Node.js script: ${scriptName}`);
          try {
            await new Promise<void>(resolve => {
              cp.exec(`pkill -f "node.*${scriptName}"`, () => {
                this.outputChannel.appendLine(`\n[INFO] Completed Node.js process cleanup`);
                resolve();
              });
            });
          } catch (e) {
            // Ignore errors in auxiliary cleanup
          }
        }
      }
      
      // Final failsafe - directly kill any processes on critical ports
      // This is a last resort if the regular killing didn't work
      for (const port of criticalPorts) {
        try {
          await new Promise<void>(resolve => {
            // More aggressive direct kill of processes bound to the port
            cp.exec(`lsof -ti:${port} | xargs kill -9`, () => {
              this.outputChannel.appendLine(`\n[INFO] Forced cleanup of processes using port ${port}`);
              resolve();
            });
          });
        } catch (e) {
          // Ignore errors in cleanup
        }
      }
    }
    
    this.outputChannel.appendLine(`\n[INFO] Process termination completed`);
  }
  
  /**
   * Detect possible ports from a command string
   */
  private detectPossiblePorts(command: string): number[] {
    const ports: number[] = [];
    
    // Common default ports 
    if (command.includes('npm run dev') || command.includes('vite')) {
      ports.push(5173); // Vite default port
    }
    
    if (command.includes('npm run start') || command.includes('node server')) {
      ports.push(5000, 3000, 8000, 8080); // Common server ports
    }
    
    // Look for explicit port definitions
    const portMatches = command.match(/(?:PORT|port)=(\d{2,5})/g);
    if (portMatches) {
      portMatches.forEach(match => {
        const port = parseInt(match.split('=')[1], 10);
        if (port > 0 && port < 65536 && !ports.includes(port)) {
          ports.push(port);
        }
      });
    }
    
    return ports;
  }
  
  /**
   * Check if specified ports are in use and by which process
   */
  private async checkPortsInUse(ports: number[], filterPids: number[] = []): Promise<Array<{port: number, pid: number}>> {
    const result: Array<{port: number, pid: number}> = [];
    
    if (process.platform === 'win32') {
      // Windows implementation
      const promises = ports.map(async (port) => {
        return new Promise<void>((resolve) => {
          cp.exec(`netstat -ano | findstr :${port}`, (error, stdout) => {
            if (!error && stdout) {
              const lines = stdout.trim().split('\n');
              for (const line of lines) {
                // Parse the PID from the last column of netstat output
                const match = line.trim().match(/(\d+)$/);
                if (match && match[1]) {
                  const pid = parseInt(match[1], 10);
                  if (!isNaN(pid) && (!filterPids.length || filterPids.includes(pid))) {
                    result.push({ port, pid });
                    break;
                  }
                }
              }
            }
            resolve();
          });
        });
      });
      
      await Promise.all(promises);
    } else {
      // Unix implementation
      const promises = ports.map(async (port) => {
        return new Promise<void>((resolve) => {
          cp.exec(`lsof -i:${port} -P -n -t`, (error, stdout) => {
            if (!error && stdout) {
              const pid = parseInt(stdout.trim(), 10);
              if (!isNaN(pid) && (!filterPids.length || filterPids.includes(pid))) {
                result.push({ port, pid });
              }
            }
            resolve();
          });
        });
      });
      
      await Promise.all(promises);
    }
    
    return result;
  }
  
  /**
   * Find child processes of a given PID
   */
  private async findChildProcesses(pid: number): Promise<number[]> {
    const childPids: number[] = [];
    
    if (process.platform === 'win32') {
      // Windows implementation
      try {
        // Use WMIC to find child processes on Windows
        const { stdout } = await new Promise<{stdout: string, stderr: string}>((resolve, reject) => {
          cp.exec(`wmic process where (ParentProcessId=${pid}) get ProcessId`, (error, stdout, stderr) => {
            if (error) {
              reject(error);
            } else {
              resolve({ stdout, stderr });
            }
          });
        });
        
        const lines = stdout.trim().split('\n').slice(1); // Skip header line
        for (const line of lines) {
          const childPid = parseInt(line.trim(), 10);
          if (!isNaN(childPid)) {
            childPids.push(childPid);
            
            // Recursively get children of this child process
            try {
              const grandchildren = await this.findChildProcesses(childPid);
              childPids.push(...grandchildren);
            } catch (e) {
              // Ignore errors in recursive calls
            }
          }
        }
      } catch (e) {
        // Fallback to PowerShell if WMIC fails
        try {
          const { stdout } = await new Promise<{stdout: string, stderr: string}>((resolve, reject) => {
            cp.exec(`powershell "Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${pid} } | Select-Object -ExpandProperty ProcessId"`, 
              (error, stdout, stderr) => {
                if (error) {
                  reject(error);
                } else {
                  resolve({ stdout, stderr });
                }
              });
          });
          
          const lines = stdout.trim().split('\n');
          for (const line of lines) {
            const childPid = parseInt(line.trim(), 10);
            if (!isNaN(childPid)) {
              childPids.push(childPid);
            }
          }
        } catch (e2) {
          // If both methods fail, return empty array
        }
      }
    } else {
      // Unix implementation
      try {
        const { stdout } = await new Promise<{stdout: string, stderr: string}>((resolve, reject) => {
          cp.exec(`pgrep -P ${pid}`, (error, stdout, stderr) => {
            if (error && error.code !== 1) { // pgrep returns 1 if no processes match
              reject(error);
            } else {
              resolve({ stdout, stderr });
            }
          });
        });
        
        const lines = stdout.trim().split('\n');
        for (const line of lines) {
          if (line.trim()) {
            const childPid = parseInt(line.trim(), 10);
            if (!isNaN(childPid)) {
              childPids.push(childPid);
              
              // Recursively get children of this child process
              try {
                const grandchildren = await this.findChildProcesses(childPid);
                childPids.push(...grandchildren);
              } catch (e) {
                // Ignore errors in recursive calls
              }
            }
          }
        }
      } catch (e) {
        // If pgrep fails, try ps
        try {
          const { stdout } = await new Promise<{stdout: string, stderr: string}>((resolve, reject) => {
            cp.exec(`ps -o pid --ppid ${pid} --no-headers`, (error, stdout, stderr) => {
              if (error) {
                reject(error);
              } else {
                resolve({ stdout, stderr });
              }
            });
          });
          
          const lines = stdout.trim().split('\n');
          for (const line of lines) {
            if (line.trim()) {
              const childPid = parseInt(line.trim(), 10);
              if (!isNaN(childPid)) {
                childPids.push(childPid);
              }
            }
          }
        } catch (e2) {
          // If both methods fail, return empty array
        }
      }
    }
    
    return childPids;
  }

  /**
   * Helper method to list files recursively in a directory
   */
  private listFilesRecursively(dir: string, fileList: string[], baseDir?: string): void {
    const currentBaseDir = baseDir || dir;
    const files = fs.readdirSync(dir);
    
    files.forEach(file => {
      const filePath = path.join(dir, file);
      const relPath = path.relative(currentBaseDir, filePath);
      
      // Skip files that match ignore patterns
      if (this.shouldIgnorePath(relPath, currentBaseDir)) {
        return;
      }
      
      if (fs.statSync(filePath).isDirectory()) {
        this.listFilesRecursively(filePath, fileList, currentBaseDir);
      } else {
        // Add the file to the list if it's not ignored
        fileList.push(relPath);
      }
    });
  }
} 