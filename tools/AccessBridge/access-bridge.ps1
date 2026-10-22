param(
    [ValidateSet('Jet4', 'ACE12', 'ACE16')]
    [string]$Provider = 'Jet4'
)

# One UTF-8 JSON request on stdin, one UTF-8 JSON result on stdout.
# The caller chooses the PowerShell process architecture. No driver is installed.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$providerNames = @{
    Jet4 = 'Microsoft.Jet.OLEDB.4.0'
    ACE12 = 'Microsoft.ACE.OLEDB.12.0'
    ACE16 = 'Microsoft.ACE.OLEDB.16.0'
}
$providerName = $providerNames[$Provider]
$invariant = [Globalization.CultureInfo]::InvariantCulture

function Quote-Identifier([string]$Name) {
    if ([string]::IsNullOrWhiteSpace($Name) -or $Name -match '[\]\x00-\x1f]') {
        throw 'Invalid Access table or column identifier.'
    }
    return '[' + $Name + ']'
}

function Get-Property($Object, [string]$Name, $Default = $null) {
    if ($null -eq $Object) { return $Default }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $Default }
    return ,$property.Value
}

function Assert-PlainObject($Object, [string]$Label) {
    if ($null -eq $Object -or $Object -isnot [Management.Automation.PSCustomObject]) {
        throw ($Label + ' must be a JSON object.')
    }
}

function Get-MdbPath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path) -or $Path -notmatch '^[A-Za-z]:[\\/]') {
        throw 'A fully qualified local MDB file path is required.'
    }
    $fullPath = [IO.Path]::GetFullPath($Path)
    if ([IO.Path]::GetExtension($fullPath) -ine '.mdb') { throw 'Only .mdb files are supported.' }
    if (-not [IO.File]::Exists($fullPath)) { throw 'The MDB file does not exist.' }
    if (([IO.File]::GetAttributes($fullPath) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'MDB symbolic links and reparse points are not supported.'
    }
    $parentPath = [IO.Path]::GetDirectoryName($fullPath)
    if (([IO.File]::GetAttributes($parentPath) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'MDB parent directories must not be reparse points.'
    }
    return $fullPath
}

function Get-ConnectionString([string]$Path, [bool]$Writable) {
    $builder = New-Object Data.OleDb.OleDbConnectionStringBuilder
    $builder.Provider = $providerName
    $builder['Data Source'] = $Path
    if ($Writable) { $builder['Mode'] = 'Share Exclusive' }
    else { $builder['Mode'] = 'Read' }
    return $builder.ConnectionString
}

function Open-Connection([string]$Path, [bool]$Writable) {
    $connection = New-Object Data.OleDb.OleDbConnection (Get-ConnectionString $Path $Writable)
    try { $connection.Open() }
    catch { $connection.Dispose(); throw }
    return $connection
}

function Get-LocalTableNames([string]$Path) {
    # ADOX distinguishes LINK from TABLE even when a provider exposes both as
    # TABLE in the generic OLE DB rowset. Never follow a linked table's target.
    $catalog = $null
    $activeConnection = $null
    $tables = $null
    $names = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    try {
        $catalog = New-Object -ComObject ADOX.Catalog
        $catalog.ActiveConnection = Get-ConnectionString $Path $false
        $activeConnection = $catalog.ActiveConnection
        $tables = $catalog.Tables
        for ($index = 0; $index -lt $tables.Count; $index++) {
            $table = $null
            try {
                $table = $tables.Item($index)
                $name = [string]$table.Name
                if ([string]$table.Type -ceq 'TABLE' -and $name -notmatch '^(MSys|USys|~)') {
                    [void](Quote-Identifier $name)
                    [void]$names.Add($name)
                }
            } finally {
                if ($null -ne $table) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($table) }
            }
        }
    } finally {
        if ($null -ne $tables) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($tables) }
        if ($null -ne $activeConnection) {
            try { $activeConnection.Close() } catch { }
            [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($activeConnection)
        }
        if ($null -ne $catalog) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($catalog) }
    }
    return ,$names
}

function Get-TypeName([int]$DataType, [bool]$IsLong) {
    switch ($DataType) {
        2 { return 'integer' }
        3 { return 'long' }
        4 { return 'float' }
        5 { return 'double' }
        6 { return 'currency' }
        7 { return 'datetime' }
        11 { return 'boolean' }
        14 { return 'numeric' }
        17 { return 'byte' }
        72 { return 'repid' }
        128 { if ($IsLong) { return 'ole' }; return 'binary' }
        129 { if ($IsLong) { return 'memo' }; return 'text' }
        130 { if ($IsLong) { return 'memo' }; return 'text' }
        131 { return 'numeric' }
        133 { return 'datetime' }
        134 { return 'datetime' }
        135 { return 'datetime' }
        default { return 'unsupported' }
    }
}

function Get-DatabaseMetadata($Connection, $LocalNames) {
    $tableSchema = $null
    $columnSchema = $null
    $keySchema = $null
    $result = New-Object Collections.ArrayList
    try {
        $tableSchema = $Connection.GetOleDbSchemaTable([Data.OleDb.OleDbSchemaGuid]::Tables, $null)
        $columnSchema = $Connection.GetOleDbSchemaTable([Data.OleDb.OleDbSchemaGuid]::Columns, $null)
        $keySchema = $Connection.GetOleDbSchemaTable([Data.OleDb.OleDbSchemaGuid]::Primary_Keys, $null)
        foreach ($tableRow in $tableSchema.Rows) {
            $name = [string]$tableRow['TABLE_NAME']
            if ([string]$tableRow['TABLE_TYPE'] -ine 'TABLE' -or -not $LocalNames.Contains($name)) { continue }
            $quoted = Quote-Identifier $name
            $command = $Connection.CreateCommand()
            $reader = $null
            $readerSchema = $null
            try {
                $command.CommandText = 'SELECT * FROM ' + $quoted + ' WHERE 1 = 0'
                $reader = $command.ExecuteReader([Data.CommandBehavior]::SchemaOnly -bor [Data.CommandBehavior]::KeyInfo)
                $readerSchema = $reader.GetSchemaTable()
                $columns = New-Object Collections.ArrayList
                $rows = @($columnSchema.Rows | Where-Object { [string]$_['TABLE_NAME'] -ceq $name } | Sort-Object { [int]$_['ORDINAL_POSITION'] })
                foreach ($column in $rows) {
                    $columnName = [string]$column['COLUMN_NAME']
                    [void](Quote-Identifier $columnName)
                    $details = @($readerSchema.Rows | Where-Object { [string]$_['ColumnName'] -ceq $columnName })
                    if ($details.Count -ne 1) { throw 'The provider returned ambiguous column metadata.' }
                    $detail = $details[0]
                    $flags = [int]$column['COLUMN_FLAGS']
                    $isLong = ($flags -band 128) -ne 0
                    $dataType = [int]$column['DATA_TYPE']
                    $typeName = Get-TypeName $dataType $isLong
                    $providerType = [string]([Data.OleDb.OleDbType][int]$detail['ProviderType'])
                    $size = 0
                    if ($column['CHARACTER_MAXIMUM_LENGTH'] -isnot [DBNull]) { $size = [long]$column['CHARACTER_MAXIMUM_LENGTH'] }
                    $nullable = [bool]$detail['AllowDBNull']
                    $autoIncrement = [bool]$detail['IsAutoIncrement']
                    $readOnly = [bool]$detail['IsReadOnly']
                    [void]$columns.Add([pscustomobject]@{
                        name = $columnName; type = $typeName; providerType = $providerType
                        nullable = $nullable; size = $size; autoIncrement = $autoIncrement
                        fixedLength = (($flags -band 16) -ne 0); readOnly = $readOnly
                    })
                }
                $keys = @($keySchema.Rows | Where-Object { [string]$_['TABLE_NAME'] -ceq $name } | Sort-Object { [int]$_['ORDINAL'] } | ForEach-Object { [string]$_['COLUMN_NAME'] })
                [void]$result.Add([pscustomobject]@{ name = $name; columns = @($columns); primaryKey = $keys; linked = $false; readOnly = $false })
            } finally {
                if ($null -ne $readerSchema) { $readerSchema.Dispose() }
                if ($null -ne $reader) { $reader.Dispose() }
                $command.Dispose()
            }
        }
    } finally {
        if ($null -ne $keySchema) { $keySchema.Dispose() }
        if ($null -ne $columnSchema) { $columnSchema.Dispose() }
        if ($null -ne $tableSchema) { $tableSchema.Dispose() }
    }
    return ,@($result)
}

function Add-ValueParameter($Command, $Column, $Value, [bool]$ForWrite) {
    if ($Column.type -in @('binary', 'ole', 'unsupported')) { throw ('Unsupported Access field type: ' + $Column.name) }
    if ($ForWrite -and ($Column.autoIncrement -or $Column.readOnly)) { throw ('The Access field is read-only: ' + $Column.name) }
    if ($null -ne $Value -and $Value -isnot [string] -and $Value -isnot [ValueType]) { throw 'Access values must be JSON scalars.' }
    $parameterType = [Data.OleDb.OleDbType]$Column.providerType
    if ($Column.type -eq 'memo') { $parameterType = [Data.OleDb.OleDbType]::LongVarWChar }
    if ($Column.type -eq 'text') { $parameterType = [Data.OleDb.OleDbType]::VarWChar }
    $parameter = $Command.Parameters.Add('?', $parameterType)
    if ($Column.type -in @('text', 'memo')) {
        if ($null -ne $Value -and $Value -isnot [string]) { throw ('A text value is required: ' + $Column.name) }
        if ($Column.type -eq 'text' -and $null -ne $Value -and $Value.Length -gt $Column.size) { throw ('Text exceeds the Access column size: ' + $Column.name) }
        $parameter.Size = [Math]::Max(1, [Math]::Min([int]::MaxValue, [long]$Column.size))
        if ($Column.type -eq 'memo' -and $null -ne $Value) { $parameter.Size = [Math]::Max(1, $Value.Length) }
    }
    if ($null -eq $Value) {
        if ($ForWrite -and -not $Column.nullable) { throw ('NULL is not allowed: ' + $Column.name) }
        $parameter.Value = [DBNull]::Value
        return
    }
    if ($Column.type -in @('byte', 'integer', 'long', 'float', 'double', 'currency', 'numeric') -and $Value -is [bool]) {
        throw ('A numeric value is required: ' + $Column.name)
    }
    if ($Column.type -in @('byte', 'integer', 'long')) {
        $integerValue = [decimal]::Parse([Convert]::ToString($Value, $invariant), [Globalization.NumberStyles]::Float, $invariant)
        if ([decimal]::Truncate($integerValue) -ne $integerValue) { throw ('An integer value is required: ' + $Column.name) }
    }
    switch ($Column.type) {
        'byte' { $parameter.Value = [Convert]::ToByte($Value, $invariant) }
        'integer' { $parameter.Value = [Convert]::ToInt16($Value, $invariant) }
        'long' { $parameter.Value = [Convert]::ToInt32($Value, $invariant) }
        'float' {
            $number = [Convert]::ToSingle($Value, $invariant)
            if ([single]::IsNaN($number) -or [single]::IsInfinity($number)) { throw 'Non-finite numbers are not supported.' }
            $parameter.Value = $number
        }
        'double' {
            $number = [Convert]::ToDouble($Value, $invariant)
            if ([double]::IsNaN($number) -or [double]::IsInfinity($number)) { throw 'Non-finite numbers are not supported.' }
            $parameter.Value = $number
        }
        { $_ -in @('currency', 'numeric') } { $parameter.Value = [decimal]::Parse([Convert]::ToString($Value, $invariant), [Globalization.NumberStyles]::Float, $invariant) }
        'boolean' {
            if ($Value -isnot [bool]) { throw ('A boolean value is required: ' + $Column.name) }
            $parameter.Value = [bool]$Value
        }
        'datetime' {
            if ($Value -isnot [string] -or $Value -notmatch '^\d{4}-\d{2}-\d{2}T') { throw 'Access dates must be ISO date-time strings.' }
            $parameter.Value = [datetime]::Parse($Value, $invariant, [Globalization.DateTimeStyles]::RoundtripKind)
        }
        'repid' { $parameter.Value = [guid]::Parse([string]$Value) }
        default { $parameter.Value = $Value }
    }
}

function Get-ColumnMap($Table) {
    $map = New-Object 'Collections.Generic.Dictionary[string,object]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($column in $Table.columns) { $map.Add($column.name, $column) }
    return ,$map
}

function Add-Where($Command, $Where, $Columns) {
    Assert-PlainObject $Where 'where'
    $parts = New-Object Collections.ArrayList
    foreach ($property in $Where.PSObject.Properties) {
        if (-not $Columns.ContainsKey($property.Name)) { throw ('Unknown Access column: ' + $property.Name) }
        $column = $Columns[$property.Name]
        if ($column.type -in @('binary', 'ole', 'unsupported')) { throw ('Unsupported Access identity field: ' + $column.name) }
        if ($null -eq $property.Value) { [void]$parts.Add((Quote-Identifier $column.name) + ' IS NULL') }
        else {
            Add-ValueParameter $Command $column $property.Value $false
            [void]$parts.Add((Quote-Identifier $column.name) + ' = ?')
        }
    }
    if ($parts.Count -eq 0) { throw 'A non-empty row identity is required.' }
    return ' WHERE ' + ($parts -join ' AND ')
}

function Invoke-Mutation($Request, [string]$Path) {
    if ([IO.Path]::GetFileName($Path) -notlike '.boo-access-*.mdb') { throw 'MDB mutations require an isolated .boo-access-*.mdb candidate.' }
    $tableName = [string](Get-Property $Request 'tableName')
    $operations = Get-Property $Request 'operations'
    if ($operations -isnot [array] -or $operations.Count -eq 0 -or $operations.Count -gt 10000) { throw 'operations must contain between 1 and 10000 mutations.' }
    $localNames = Get-LocalTableNames $Path
    $connection = Open-Connection $Path $true
    $transaction = $null
    $affectedRows = 0
    try {
        $metadata = Get-DatabaseMetadata $connection $localNames
        $matches = @($metadata | Where-Object { $_.name -ceq $tableName })
        if ($matches.Count -ne 1) { throw 'Only a local ordinary Access table may be edited.' }
        $table = $matches[0]
        $quotedTable = Quote-Identifier $table.name
        $columns = Get-ColumnMap $table
        $transaction = $connection.BeginTransaction()
        foreach ($operation in $operations) {
            Assert-PlainObject $operation 'operation'
            $kind = [string](Get-Property $operation 'kind')
            if ($kind -cnotin @('create', 'update', 'delete')) { throw 'Unsupported Access mutation kind.' }
            $command = $connection.CreateCommand()
            try {
                $command.Transaction = $transaction
                if ($kind -ne 'create') {
                    $where = Add-Where $command (Get-Property $operation 'where') $columns
                    $command.CommandText = 'SELECT COUNT(*) FROM ' + $quotedTable + $where
                    if ([long]$command.ExecuteScalar() -ne 1) { throw 'Access row identity must match exactly one row.' }
                    $command.Parameters.Clear()
                }
                if ($kind -eq 'delete') {
                    $command.CommandText = 'DELETE FROM ' + $quotedTable + (Add-Where $command (Get-Property $operation 'where') $columns)
                } else {
                    $values = Get-Property $operation 'values'
                    Assert-PlainObject $values 'values'
                    $names = New-Object Collections.ArrayList
                    $markers = New-Object Collections.ArrayList
                    $assignments = New-Object Collections.ArrayList
                    foreach ($property in $values.PSObject.Properties) {
                        if (-not $columns.ContainsKey($property.Name)) { throw ('Unknown Access column: ' + $property.Name) }
                        $column = $columns[$property.Name]
                        Add-ValueParameter $command $column $property.Value $true
                        $quotedColumn = Quote-Identifier $column.name
                        [void]$names.Add($quotedColumn)
                        [void]$markers.Add('?')
                        [void]$assignments.Add($quotedColumn + ' = ?')
                    }
                    if ($names.Count -eq 0) { throw 'At least one writable value is required.' }
                    if ($kind -eq 'create') {
                        $command.CommandText = 'INSERT INTO ' + $quotedTable + ' (' + ($names -join ', ') + ') VALUES (' + ($markers -join ', ') + ')'
                    } else {
                        $command.CommandText = 'UPDATE ' + $quotedTable + ' SET ' + ($assignments -join ', ') + (Add-Where $command (Get-Property $operation 'where') $columns)
                    }
                }
                $count = $command.ExecuteNonQuery()
                if ($count -ne 1) { throw 'An Access mutation must affect exactly one row.' }
                $affectedRows += $count
            } finally { $command.Dispose() }
        }
        $transaction.Commit()
    } catch {
        if ($null -ne $transaction) { try { $transaction.Rollback() } catch { } }
        throw
    } finally {
        if ($null -ne $transaction) { $transaction.Dispose() }
        $connection.Dispose()
    }
    $connection = Open-Connection $Path $false
    try {
        $command = $connection.CreateCommand()
        try {
            $command.CommandText = 'SELECT COUNT(*) FROM ' + (Quote-Identifier $tableName)
            $rowCount = [long]$command.ExecuteScalar()
        } finally { $command.Dispose() }
    } finally { $connection.Dispose() }
    return @{ ok = $true; rowCount = $rowCount; affectedRows = $affectedRows }
}

function Get-StreamHash($Stream) {
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hash.ComputeHash($Stream))).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose() }
}

function Assert-NoAccessLock([string]$Path) {
    foreach ($extension in @('.ldb', '.laccdb')) {
        if ([IO.File]::Exists([IO.Path]::ChangeExtension($Path, $extension))) { throw 'The Access database has an active lock file. Close other database programs first.' }
    }
}

function Invoke-Replacement($Request) {
    $sourcePath = Get-MdbPath ([string](Get-Property $Request 'sourcePath'))
    $candidatePath = Get-MdbPath ([string](Get-Property $Request 'candidatePath'))
    $directory = [IO.Path]::GetDirectoryName($sourcePath)
    if ([IO.Path]::GetDirectoryName($candidatePath) -ine $directory -or [IO.Path]::GetFileName($candidatePath) -notlike '.boo-access-*.mdb' -or $sourcePath -ieq $candidatePath) {
        throw 'An Access replacement requires a distinct same-directory .boo-access-*.mdb candidate.'
    }
    $backupPathText = [string](Get-Property $Request 'backupPath')
    if (-not [IO.Path]::IsPathRooted($backupPathText)) { throw 'An absolute backup path is required.' }
    $backupPath = [IO.Path]::GetFullPath($backupPathText)
    $backupDirectory = Join-Path $directory 'boo-database-backups'
    if ([IO.Path]::GetDirectoryName($backupPath) -ine $backupDirectory -or [IO.File]::Exists($backupPath) -or [IO.Directory]::Exists($backupPath)) {
        throw 'The backup must be a new file under the database boo-database-backups directory.'
    }
    $expected = [string](Get-Property $Request 'expectedSha256')
    if ($expected -notmatch '^[0-9a-fA-F]{64}$') { throw 'A valid expected SHA-256 is required.' }
    $expectedCandidate = [string](Get-Property $Request 'expectedCandidateSha256')
    if ($expectedCandidate -notmatch '^[0-9a-fA-F]{64}$') { throw 'A valid verified candidate SHA-256 is required.' }
    [void][IO.Directory]::CreateDirectory($backupDirectory)
    if (([IO.File]::GetAttributes($backupDirectory) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'The backup directory must not be a reparse point.' }
    Assert-NoAccessLock $sourcePath
    $sourceStream = $null
    $candidateStream = $null
    try {
        $sharing = [IO.FileShare]::Read -bor [IO.FileShare]::Delete
        $sourceStream = New-Object IO.FileStream($sourcePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, $sharing)
        if ((Get-StreamHash $sourceStream) -ine $expected) { throw 'The MDB file was changed by another program. The replacement was cancelled.' }
        $candidateStream = New-Object IO.FileStream($candidatePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, $sharing)
        $candidateHash = Get-StreamHash $candidateStream
        if ($candidateHash -ine $expectedCandidate) { throw 'The verified MDB candidate was changed. The replacement was cancelled.' }
        $candidateStream.Dispose()
        $candidateStream = $null
        Assert-NoAccessLock $sourcePath
        [IO.File]::Replace($candidatePath, $sourcePath, $backupPath)
    } finally {
        if ($null -ne $candidateStream) { $candidateStream.Dispose() }
        if ($null -ne $sourceStream) { $sourceStream.Dispose() }
    }
    return @{ ok = $true; sha256 = $candidateHash; backupPath = $backupPath }
}

try {
    $requestText = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($requestText)) { throw 'A JSON request is required.' }
    $request = $requestText | ConvertFrom-Json
    Assert-PlainObject $request 'request'
    $action = [string](Get-Property $request 'action')
    switch -CaseSensitive ($action) {
        'probe' {
            $enumerator = New-Object Data.OleDb.OleDbEnumerator
            $sources = $enumerator.GetElements()
            try {
                $providers = @($sources.Rows | ForEach-Object { [string]$_['SOURCES_NAME'] })
                if ($providers -inotcontains $providerName) { throw 'The requested OLE DB provider is not registered for this process architecture.' }
            } finally { $sources.Dispose() }
            $result = @{ ok = $true; provider = $providerName; architecture = ([IntPtr]::Size * 8) }
        }
        'inspect' {
            $path = Get-MdbPath ([string](Get-Property $request 'filePath'))
            $localNames = Get-LocalTableNames $path
            $connection = Open-Connection $path $false
            try { $tables = Get-DatabaseMetadata $connection $localNames }
            finally { $connection.Dispose() }
            $result = @{ ok = $true; provider = $providerName; tables = @($tables) }
        }
        'mutate' { $result = Invoke-Mutation $request (Get-MdbPath ([string](Get-Property $request 'filePath'))) }
        'replace' { $result = Invoke-Replacement $request }
        default { throw 'Unknown Access bridge action.' }
    }
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 32 -Compress))
    exit 0
} catch {
    # Keep provider diagnostics, but never serialize a connection or its string.
    $message = $_.Exception.Message
    [Console]::Out.WriteLine((@{ ok = $false; error = $message } | ConvertTo-Json -Depth 4 -Compress))
    exit 1
}
