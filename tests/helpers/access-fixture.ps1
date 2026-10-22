param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string]$Provider,
    [ValidateSet('create', 'external')][string]$Action = 'create'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$connection = $null
$catalog = $null

function Invoke-FixtureSql([string]$Sql, [object[]]$Parameters = @()) {
    $command = $connection.CreateCommand()
    try {
        $command.CommandText = $Sql
        foreach ($entry in $Parameters) {
            $parameter = $command.Parameters.Add($entry.Name, [Data.OleDb.OleDbType]$entry.Type)
            if ($entry.ContainsKey('Size')) { $parameter.Size = $entry.Size }
            if ($null -eq $entry.Value) { $parameter.Value = [DBNull]::Value }
            else { $parameter.Value = $entry.Value }
        }
        [void]$command.ExecuteNonQuery()
    } finally {
        $command.Dispose()
    }
}

try {
    $providerNames = @()
    $enumerator = [Data.OleDb.OleDbEnumerator]::GetRootEnumerator()
    try {
        while ($enumerator.Read()) { $providerNames += $enumerator['SOURCES_NAME'].ToString() }
    } finally { $enumerator.Dispose() }
    if ($providerNames -notcontains $Provider) {
        @{ available = $false; reason = ('Provider is not registered: ' + $Provider) } | ConvertTo-Json -Compress
        exit 0
    }

    $builder = New-Object Data.OleDb.OleDbConnectionStringBuilder
    $builder.Provider = $Provider
    $builder['Data Source'] = $FilePath
    $builder['Jet OLEDB:Engine Type'] = 5
    if ($Action -eq 'create') {
        if (Test-Path -LiteralPath $FilePath) { throw 'The synthetic fixture must not overwrite an existing file.' }
        $catalog = New-Object -ComObject ADOX.Catalog
        [void]$catalog.Create($builder.ConnectionString)
        $catalog.ActiveConnection.Close()
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($catalog)
        $catalog = $null
    }
    $connection = New-Object Data.OleDb.OleDbConnection($builder.ConnectionString)
    $connection.Open()

    if ($Action -eq 'external') {
        Invoke-FixtureSql 'UPDATE [StdItems] SET [Price] = 54321 WHERE [Id] = 1'
    } else {
        Invoke-FixtureSql 'CREATE TABLE [StdItems] ([Id] LONG NOT NULL, [Name] TEXT(60), [Price] LONG NOT NULL, [Enabled] YESNO, [Note] MEMO, [Optional] LONG, [Created] DATETIME, CONSTRAINT [PK_StdItems] PRIMARY KEY ([Id]))'
        $chinese = ([string][char]0x4E2D) + [char]0x6587
        for ($index = 1; $index -le 3; $index++) {
            Invoke-FixtureSql 'INSERT INTO [StdItems] ([Id], [Name], [Price], [Enabled], [Note], [Optional], [Created]) VALUES (?, ?, ?, ?, ?, ?, ?)' @(
                @{ Name = 'Id'; Type = 'Integer'; Value = $index },
                @{ Name = 'Name'; Type = 'VarWChar'; Size = 60; Value = ($chinese + 'Item' + $index) },
                @{ Name = 'Price'; Type = 'Integer'; Value = ($index * 10) },
                @{ Name = 'Enabled'; Type = 'Boolean'; Value = ($index -ne 2) },
                @{ Name = 'Note'; Type = 'LongVarWChar'; Value = ('original memo ' + $index) },
                @{ Name = 'Optional'; Type = 'Integer'; Value = $null },
                @{ Name = 'Created'; Type = 'Date'; Value = [datetime]'2026-10-20T12:34:56' }
            )
        }
        Invoke-FixtureSql 'CREATE TABLE [NoKey] ([Name] TEXT(40), [Value] LONG)'
        Invoke-FixtureSql "INSERT INTO [NoKey] ([Name], [Value]) VALUES ('unique', 11)"
        Invoke-FixtureSql 'INSERT INTO [NoKey] ([Name], [Value]) VALUES (NULL, 22)'
        Invoke-FixtureSql 'CREATE TABLE [Duplicates] ([Name] TEXT(40), [Value] LONG)'
        Invoke-FixtureSql "INSERT INTO [Duplicates] ([Name], [Value]) VALUES ('same', 7)"
        Invoke-FixtureSql "INSERT INTO [Duplicates] ([Name], [Value]) VALUES ('same', 7)"
        Invoke-FixtureSql 'CREATE TABLE [BinaryKey] ([Id] LONG NOT NULL, [Name] TEXT(40), [Payload] OLEOBJECT, CONSTRAINT [PK_BinaryKey] PRIMARY KEY ([Id]))'
        Invoke-FixtureSql 'INSERT INTO [BinaryKey] ([Id], [Name], [Payload]) VALUES (?, ?, ?)' @(
            @{ Name = 'Id'; Type = 'Integer'; Value = 1 },
            @{ Name = 'Name'; Type = 'VarWChar'; Size = 40; Value = 'binary survivor' },
            @{ Name = 'Payload'; Type = 'LongVarBinary'; Value = [byte[]]@(0, 1, 2, 255, 64, 128) }
        )
        Invoke-FixtureSql 'CREATE TABLE [Child] ([Id] LONG NOT NULL, [ParentId] LONG NOT NULL, CONSTRAINT [PK_Child] PRIMARY KEY ([Id]), CONSTRAINT [FK_Child_Items] FOREIGN KEY ([ParentId]) REFERENCES [StdItems] ([Id]))'
        Invoke-FixtureSql 'INSERT INTO [Child] ([Id], [ParentId]) VALUES (1, 1)'
        Invoke-FixtureSql 'CREATE TABLE [PreciseNumbers] ([Id] LONG NOT NULL, [Amount] CURRENCY, [ExactValue] DECIMAL(20, 4), CONSTRAINT [PK_PreciseNumbers] PRIMARY KEY ([Id]))'
        Invoke-FixtureSql 'INSERT INTO [PreciseNumbers] ([Id], [Amount], [ExactValue]) VALUES (?, ?, ?)' @(
            @{ Name = 'Id'; Type = 'Integer'; Value = 1 },
            @{ Name = 'Amount'; Type = 'Currency'; Value = [decimal]::Parse('1.0001', [Globalization.CultureInfo]::InvariantCulture) },
            @{ Name = 'ExactValue'; Type = 'Decimal'; Value = [decimal]::Parse('2.0002', [Globalization.CultureInfo]::InvariantCulture) }
        )
    }
    $connection.Close()
    $connection.Dispose()
    $connection = $null
    @{ available = $true; provider = $Provider; architecture = $(if ([Environment]::Is64BitProcess) { 64 } else { 32 }) } | ConvertTo-Json -Compress
} catch {
    [Console]::Error.WriteLine($_.Exception.ToString())
    exit 1
} finally {
    if ($null -ne $connection) { $connection.Dispose() }
    if ($null -ne $catalog) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($catalog) }
}
